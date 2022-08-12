#!/bin/bash

npm run build
cp -r ./public/*png ./dist
cp -r ./public/data ./dist
cp -r ./public/img ./dist
cp -r ./public/video ./dist
cp -r ./public/build ./dist
cp -r ./public/global.css ./dist

cp -r lite/output ./dist/notebook

cd ./dist
git add ./*
git commit -s -m "Deploy: $(git log '--format=format:%H' master -1)"
git push origin gh-pages