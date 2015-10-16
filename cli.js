#!/usr/bin/env node

'use strict'

require('./')()
  .on('error', function (err) {
    if (err.code === 403) {
      console.error(new Error('Authentication failed. Did you provide a `keyFilename` or `credentials` object in your package.json?'))
    } else {
      console.error(err)
    }
  })
  .on('file', function (file) {
    console.log('Backup created:', file.bucket.name + '/' + file.name)
  })
  .on('vm', function (vm) {
    console.log('VM created:', vm.name)
  })
  .on('output', function (output) {
    output.on('data', console.log)
  })
  .on('start', function (url) {
    console.log('Deployed successfully!', url)
  })
