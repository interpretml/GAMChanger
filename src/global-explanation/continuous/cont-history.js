import { quitSelection } from './cont-brush';
import { get } from 'svelte/store';
import { drawLastEdit, redrawOriginal } from './cont-edit';
import { MD5 } from '../../utils/md5';

/**
 * Undo the last commit
 * @param {object} state Global state
 * @param {element} svg SVG element
 * @param {element} multiMenu multiMenu element
 * @param {func} resetContextMenu function to reset context menu bar
 * @param {func} resetFeatureSidebar function to reset the feature side bar
 * @param {object} historyStore History store
 * @param {list} redoStack List of commits to redo
 * @param {func} setEBM function to set EBM bin definitions
 * @param {object} sidebarStore sidebar store object
 */
export const undoHandler = async (state, svg, multiMenu, resetContextMenu, resetFeatureSidebar,
  historyStore, redoStack, setEBM, sidebarStore) => {
  
  // If the current edit is original, we do not undo
  let curHistoryStoreValue = get(historyStore);
  if (curHistoryStoreValue[curHistoryStoreValue.length - 1].type === 'original' ||
    state.featureName !== curHistoryStoreValue[curHistoryStoreValue.length - 1].featureName
  ) {
    return;
  }

  let curCommit;
  let lastCommit;
  let lastCommitIndex;

  // Step 1: If the user has selected some nodes, discard the selections
  quitSelection(svg, state, multiMenu, resetContextMenu, resetFeatureSidebar);

  // Search for the lastEdit
  for (let i = curHistoryStoreValue.length - 2; i >= 0; i--) {
    if (curHistoryStoreValue[i].featureName === state.featureName) {
      lastCommit = curHistoryStoreValue[i];
      lastCommitIndex = i;
      break;
    }
  }

  // Step 1.5: Update the HEAD
  // This step must be done before updating the historyStore!
  sidebarStore.update(value => {
    value.historyHead = lastCommitIndex;
    if (value.historyHead !== curHistoryStoreValue.length - 2) {
      value.previewHistory = true;
    }
    return value;
  });

  // Step 2: Remove the current commit from history
  historyStore.update(value => {
    curCommit = value.pop();
    return value;
  });

  // Step 3: Save the current commit into the redo stack
  redoStack.push(curCommit);

  // Step 4: Replace the current state with lastCommit
  state.additiveData = lastCommit.state.additiveData;
  state.pointData = lastCommit.state.pointData;

  state.additiveDataBuffer = null;
  state.pointDataBuffer = null;

  // Step 5: Update the last edit state, redraw the last edit graphs

  // Note that the last last edit is possible not the one right next to lastCommit
  // because users can edit multiple features
  // Need to search it backward
  let lastLastCommit = null;
  for (let i = lastCommitIndex - 1; i >= 0; i--) {
    if (curHistoryStoreValue[i].featureName === state.featureName) {
      lastLastCommit = curHistoryStoreValue[i];
      break;
    }
  }

  if (lastLastCommit !== null) {
    state.additiveDataLastEdit = lastLastCommit.state.additiveData;
    drawLastEdit(state, svg);
  } else {
    // If there is no last edit, then it is the origin
    state.additiveDataLastEdit = undefined;
  }

  // Step 6: Update the last last edit state
  // Note lastLastEdit is *only* used to restore lastEdit after user enters editing mode then cancel
  // So when we restore it, it is the same as lastEdit
  if (lastLastCommit !== null) {
    state.additiveDataLastLastEdit = lastLastCommit.state.additiveData;
  } else {
    // If there is no last last edit, then it is the origin or the first edit
    state.additiveDataLastLastEdit = undefined;
  }

  // Step 7: If the current edit has changed the EBM bin definition, then we need
  // to reset the definition in WASM
  if (curCommit.type.includes('equal')) {
    await setEBM('current', state.pointData);
  }

  /**
   * Step 8: Update the metrics, last metrics
   * It depends on the current effect mode:
   * 1. Global: load the metrics from history stack => update the tab
   * 2. Selected: load the metrics from history stack (no draw);
   *  then the selection is canceled => show NA everywhere
   * 3. Slice: load the metrics from history stack (no draw);
   *  then reset EBM to compute the metrics
   */
  let sidebarInfo = get(sidebarStore);

  // No matter what scope it is, we need to reload the global metrics from the
  // history stack
  sidebarStore.update(value => {
    value.curGroup = 'no action';
    value.barData = JSON.parse(JSON.stringify(lastCommit.metrics.barData));
    value.confusionMatrixData = JSON.parse(JSON.stringify(lastCommit.metrics.confusionMatrixData));
    return value;
  });

  switch (sidebarInfo.effectScope) {
  case 'global':
    sidebarStore.update(value => {
      value.curGroup = 'overwrite';
      return value;
    });
    break;
  case 'selected':
    sidebarStore.update(value => {
      value.curGroup = 'nullify';
      return value;
    });
    break;
  case 'slice': {
    let historyInfo = get(historyStore);
    await setEBM('original-only', historyInfo[0].state.pointData);

    // Step 2.2: Last edit
    if (historyInfo.length > 1) {
      await setEBM('last-only', historyInfo[historyInfo.length - 2].state.pointData);
    }

    // Step 2.3: Current edit
    let curPointData = state.pointDataBuffer === null ?
      historyInfo[historyInfo.length - 1].state.pointData :
      state.pointDataBuffer;

    await setEBM('current-only', curPointData);

    // Step 2.2.5: If we didn't restore the last edit, use the current edit as last
    if (historyInfo.length === 1) {
      sidebarInfo.curGroup = 'last';
      sidebarStore.set(sidebarInfo);
    }
    break;
  }
  default:
    break;
  }

  // Redraw the graph
  redrawOriginal(state, svg);
};

/**
 * Redo the last undo.
 * @param {object} state Global state
 * @param {element} svg SVG element
 * @param {element} multiMenu multiMenu element
 * @param {func} resetContextMenu function to reset context menu bar
 * @param {func} resetFeatureSidebar function to reset the feature side bar
 * @param {object} historyStore History store
 * @param {list} redoStack List of commits to redo
 * @param {func} setEBM function to set EBM bin definitions
 * @param {object} sidebarStore sidebar store object
 */
export const redoHandler = async (state, svg, multiMenu, resetContextMenu, resetFeatureSidebar,
  historyStore, redoStack, setEBM, sidebarStore) => {
  // Step 1: If the user has selected some nodes, discard the selections
  quitSelection(svg, state, multiMenu, resetContextMenu, resetFeatureSidebar);

  // Step 1.5: Update the HEAD
  // This step must be done before updating the historyStore!
  sidebarStore.update(value => {
    value.historyHead = get(historyStore).length;
    return value;
  });

  // Step 2: Pop the redo stack and add it to the history stack
  let newCommit = redoStack.pop();

  historyStore.update(value => {
    value.push(newCommit);
    return value;
  });

  let curHistoryStoreValue = get(historyStore);

  // Replace the current state with the new commit
  state.additiveData = newCommit.state.additiveData;
  state.pointData = newCommit.state.pointData;

  state.additiveDataBuffer = null;
  state.pointDataBuffer = null;

  // Update the last edit state, redraw the last edit graphs
  if (curHistoryStoreValue.length > 1) {
    state.additiveDataLastEdit = curHistoryStoreValue[curHistoryStoreValue.length - 2].state.additiveData;
    drawLastEdit(state, svg);
  } else {
    // If there is no last edit, then it is the origin
    state.additiveDataLastEdit = undefined;
  }

  // Update the last last edit state
  // Note lastLastEdit is *only* used to restore lastEdit after user enters editing mode then cancel
  // So when we restore it, it is the same as lastEdit
  if (curHistoryStoreValue.length > 1) {
    state.additiveDataLastLastEdit = curHistoryStoreValue[curHistoryStoreValue.length - 2].state.additiveData;
  } else {
    // If there is no last last edit, then it is the origin or the first edit
    state.additiveDataLastLastEdit = undefined;
  }

  // If the current edit has changed the EBM bin definition, then we need
  // to reset the definition in WASM
  if (newCommit.type.includes('equal')) {
    await setEBM('current', state.pointData);
  }

  /**
   * Update the metrics, last metrics
   * It depends on the current effect mode:
   * 1. Global: load the metrics from redo stack => update the tab
   * 2. Selected: load the metrics from redo stack (no draw);
   *  then the selection is canceled => show NA everywhere
   * 3. Slice: load the metrics from history stack (no draw);
   *  then reset EBM to compute the metrics
   */
  let sidebarInfo = get(sidebarStore);

  // No matter what scope it is, we need to reload the global metrics from the
  // history stack
  sidebarStore.update(value => {
    value.curGroup = 'no action';
    value.barData = JSON.parse(JSON.stringify(newCommit.metrics.barData));
    value.confusionMatrixData = JSON.parse(JSON.stringify(newCommit.metrics.confusionMatrixData));
    return value;
  });

  switch (sidebarInfo.effectScope) {
  case 'global':
    sidebarStore.update(value => {
      value.curGroup = 'overwrite';
      return value;
    });
    break;
  case 'selected':
    sidebarStore.update(value => {
      value.curGroup = 'nullify';
      return value;
    });
    break;
  case 'slice': {
    let historyInfo = get(historyStore);
    await setEBM('original-only', historyInfo[0].state.pointData);

    // Step 2.2: Last edit
    if (historyInfo.length > 1) {
      await setEBM('last-only', historyInfo[historyInfo.length - 2].state.pointData);
    }

    // Step 2.3: Current edit
    let curPointData = state.pointDataBuffer === null ?
      historyInfo[historyInfo.length - 1].state.pointData :
      state.pointDataBuffer;

    await setEBM('current-only', curPointData);

    // Step 2.2.5: If we didn't restore the last edit, use the current edit as last
    if (historyInfo.length === 1) {
      sidebarInfo.curGroup = 'last';
      sidebarStore.set(sidebarInfo);
    }
    break;
  }
  default:
    break;
  }

  // Redraw the graph
  redrawOriginal(state, svg);
};

/**
 * Add a new commit to the history stack
 * @param {object} state Global state
 * @param {str} type Commit type
 * @param {str} description Commit description
 * @param {object} historyStore Store object of the history stack
 * @param {object} sidebarStore sidebar store object
 */
export const pushCurStateToHistoryStack = (state, type, description, historyStore, sidebarStore) => {
  // Push the new commit to the history stack
  let historyLength = 0;
  let sidebarInfo = get(sidebarStore);

  historyStore.update(value => {
    const time = Date.now();

    value.push({
      state: {
        pointData: state.pointData,
        additiveData: state.additiveData
      },
      metrics: {
        barData: JSON.parse(JSON.stringify(sidebarInfo.barData)),
        confusionMatrixData: JSON.parse(JSON.stringify(sidebarInfo.confusionMatrixData))
      },
      featureName: state.featureName,
      type: type,
      description: description,
      time: time,
      hash: MD5(`${type}${description}${time}`),
      reviewed: type === 'original'
    });

    historyLength = value.length;
    return value;
  });

  // Change the HEAD pointer to new commit
  sidebarStore.update(value => {
    value.historyHead = historyLength - 1;
    value.previewHistory = false;
    return value;
  });
};

/**
 * Try to restore the graph to last edit (if possible)
 * @param {object} state Global state
 * @param {element} svg SVG element
 * @param {element} multiMenu multiMenu element
 * @param {func} resetContextMenu function to reset context menu bar
 * @param {func} resetFeatureSidebar function to reset the feature side bar
 * @param {object} historyStore History store
 * @param {list} redoStack List of commits to redo
 * @param {func} setEBM function to set EBM bin definitions
 * @param {object} sidebarStore sidebar store object
 * @returns true if found a last edit, false otherwise
 */
export const tryRestoreLastEdit = async (state, svg, multiMenu, resetContextMenu, resetFeatureSidebar,
  historyStore, redoStack, setEBM, sidebarStore) => {

  let lastCommit = null;
  let lastCommitID = -1;
  let lastLastCommit = null;
  let curHistoryStoreValue = get(historyStore);

  // Try to find the last edit
  for (let i = curHistoryStoreValue.length - 1; i >= 0; i--) {
    if (curHistoryStoreValue[i].featureName === state.featureName) {
      lastCommit = curHistoryStoreValue[i];
      lastCommitID = i;
      break;
    }
  }

  if (lastCommit === null) {
    return false;
  }

  // If we have found an edit, try to find the edit before it (to restore last
  // edit info)
  for (let i = lastCommitID - 1; i >= 0; i--) {
    if (curHistoryStoreValue[i].featureName === state.featureName) {
      lastLastCommit = curHistoryStoreValue[i];
      break;
    }
  }

  // Replace the current state with last edit
  state.additiveData = lastCommit.state.additiveData;
  state.pointData = lastCommit.state.pointData;

  state.additiveDataBuffer = null;
  state.pointDataBuffer = null;

  // Update the last edit state, redraw the last edit graphs
  if (lastLastCommit !== null) {
    state.additiveDataLastEdit = lastLastCommit.state.additiveData;
    drawLastEdit(state, svg);
  } else {
    // If there is no last edit, then it is the origin
    state.additiveDataLastEdit = undefined;
  }

  // Update the last last edit state
  // Note lastLastEdit is *only* used to restore lastEdit after user enters editing mode then cancel
  // So when we restore it, it is the same as lastEdit
  if (lastLastCommit !== null) {
    state.additiveDataLastLastEdit = lastLastCommit.state.additiveData;
  } else {
    // If there is no last last edit, then it is the origin or the first edit
    state.additiveDataLastLastEdit = undefined;
  }

  // If the current edit has changed the EBM bin definition, then we need
  // to reset the definition in WASM
  await setEBM('current', state.pointData);

  // We force the effect scope to be global when switching features
  sidebarStore.update(value => {
    value.curGroup = 'no action';
    value.barData = JSON.parse(JSON.stringify(lastCommit.metrics.barData));
    value.confusionMatrixData = JSON.parse(JSON.stringify(lastCommit.metrics.confusionMatrixData));
    return value;
  });

  sidebarStore.update(value => {
    value.curGroup = 'overwrite';
    return value;
  });

  // Redraw the graph
  redrawOriginal(state, svg);

  return true;
};

/**
 * Checkout the current HEAD commit
 * @param {object} state Global state
 * @param {element} svg SVG element
 * @param {element} multiMenu multiMenu element
 * @param {func} resetContextMenu function to reset context menu bar
 * @param {func} resetFeatureSidebar function to reset the feature side bar
 * @param {object} historyStore History store
 * @param {func} setEBM function to set EBM bin definitions
 * @param {object} sidebarStore sidebar store object
 */
export const checkoutCommitHead = async (state, svg, multiMenu, resetContextMenu, resetFeatureSidebar,
  historyStore, setEBM, sidebarStore) => {

  let curHistoryStoreValue = get(historyStore);
  let sidebarInfo = get(sidebarStore);

  let targetCommit = curHistoryStoreValue[sidebarInfo.historyHead];
  let targetCommitIndex = sidebarInfo.historyHead;

  // Step 1: If the user has selected some nodes, discard the selections
  quitSelection(svg, state, multiMenu, resetContextMenu, resetFeatureSidebar);

  // Step 2: Replace the current state with targetCommit
  state.additiveData = targetCommit.state.additiveData;
  state.pointData = targetCommit.state.pointData;

  state.additiveDataBuffer = null;
  state.pointDataBuffer = null;

  // Step 3: Update the last edit state, redraw the last edit graphs

  // Note that the last last edit is possible not the one right next to lastCommit
  // because users can edit multiple features
  // Need to search it backward
  let lastCommit = null;
  for (let i = targetCommitIndex - 1; i >= 0; i--) {
    if (curHistoryStoreValue[i].featureName === state.featureName) {
      lastCommit = curHistoryStoreValue[i];
      break;
    }
  }

  if (lastCommit !== null) {
    state.additiveDataLastEdit = lastCommit.state.additiveData;
    drawLastEdit(state, svg);
  } else {
    // If there is no last edit, then it is the origin
    state.additiveDataLastEdit = undefined;
  }

  // Step 4: Update the last last edit state
  // Note lastLastEdit is *only* used to restore lastEdit after user enters editing mode then cancel
  // So when we restore it, it is the same as lastEdit
  if (lastCommit !== null) {
    state.additiveDataLastLastEdit = lastCommit.state.additiveData;
  } else {
    // If there is no last last edit, then it is the origin or the first edit
    state.additiveDataLastLastEdit = undefined;
  }

  // Step 4.5: If the user tries to check out the original graph, the lastEdit would
  // be the same as the original graph
  if (targetCommit.type === 'original') {
    state.additiveDataLastEdit = targetCommit.state.additiveData;
    state.additiveDataLastLastEdit = targetCommit.state.additiveData;
    drawLastEdit(state, svg);
  }

  // Step 5: Reset EBM bin definition
  await setEBM('current', state.pointData);


  // Update the metrics, we force it to be global scope
  sidebarStore.update(value => {
    value.barData = JSON.parse(JSON.stringify(targetCommit.metrics.barData));
    value.confusionMatrixData = JSON.parse(JSON.stringify(targetCommit.metrics.confusionMatrixData));
    value.curGroup = 'overwrite';
    return value;
  });

  // Redraw the graph
  redrawOriginal(state, svg);
};