#!/usr/bin/env node

'use strict'

var through = require('through2')

var deployStream = require('./')()

deployStream
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
  .on('start', function (url) {
    console.log('Deployed successfully!', url)
  })
  .pipe(through(function (logLine, enc, next) {
    var vm = deployStream.vm
    var url = deployStream.url

    // replace some verbosity with what's probably more helpful-- the IP
    logLine = String(logLine).replace(new RegExp(vm.name + '[^:]*', 'g'), '(' + url + ')').trim()
    next(null, '\n' + logLine)
  }))
  .pipe(process.stdout)
