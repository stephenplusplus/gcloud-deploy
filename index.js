'use strict'

var archiver = require('archiver')
var assign = require('object-assign')
var async = require('async')
var format = require('string-format-obj')
var gcloud = require('gcloud')
var multiline = require('multiline')
var outputStream = require('gce-output-stream')
var path = require('path')
var slug = require('slug')
var through = require('through2')

module.exports = function (pkgRoot) {
  pkgRoot = pkgRoot || process.cwd()

  var deployStream = through()

  var pkg = require(path.join(pkgRoot, 'package.json'))
  var gcloudConfig = pkg.gcloud || {}

  var gcloudInstance = gcloud(gcloudConfig)
  var gcs = gcloudInstance.storage()
  var gce = gcloudInstance.compute()

  async.waterfall([
    createTarStream,
    uploadTar,
    createVM,
    startVM
  ], function (err, vm) {
    if (err) return deployStream.destroy(err)

    outputStream(assign(gcloudConfig, { name: vm.name, zone: vm.zone.name }))
      .on('end', deployStream.end.bind(deployStream))
      .on('error', deployStream.destroy.bind(deployStream))
      .pipe(deployStream)
  })

  function createTarStream (callback) {
    var tarStream = archiver.create('tar', { gzip: true })
    tarStream.bulk([{ expand: true, cwd: pkgRoot, src: ['**', '!node_modules/**'] }])
    tarStream.finalize()
    callback(null, tarStream)
  }

  function uploadTar (tarStream, callback) {
    var bucketName = gcloudConfig.projectId + '-gcloud-deploy-tars'
    var bucket = gcs.bucket(bucketName)
    var tarFilename = Date.now() + '.tar'

    gcs.createBucket(bucketName, function (err) {
      if (err && err.code !== 409) return callback(err)
      deployStream.emit('bucket', bucket)
      deployStream.bucket = bucket

      var tarFile = bucket.file(tarFilename)

      tarStream.pipe(tarFile.createWriteStream({ gzip: true }))
        .on('error', callback)
        .on('finish', function () {
          deployStream.emit('file', tarFile)
          deployStream.file = tarFile

          tarFile.makePublic(function (err) {
            if (err) return callback(err)
            callback(null, tarFile)
          })
        })
    })
  }

  function createVM (file, callback) {
    var startupScript = format(multiline(function () {/*
      #! /bin/bash
      set -v
      apt-get update
      apt-get install -yq build-essential
      export NVM_DIR=/opt/nvm
      curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.29.0/install.sh | bash
      source /opt/nvm/nvm.sh
      nvm install v0
      mkdir /opt/app && cd $_
      curl https://storage.googleapis.com/{bucketName}/{fileName} | tar -xz
      npm install
      npm start &
    */}), { bucketName: file.bucket.name, fileName: file.name })

    var vmName = slug(pkg.name) + '-' + Date.now()

    var cfg = {
      os: 'centos',
      http: true,
      https: true,
      metadata: {
        items: [{ key: 'startup-script', value: startupScript }]
      }
    }

    gce.zone('us-central1-a').createVM(vmName, cfg, _onOperationComplete(function (err, vm, metadata) {
      if (err) return callback(err)

      deployStream.emit('vm', vm)
      deployStream.vm = vm

      callback(null, vm)
    }))
  }

  function startVM (vm, callback) {
    vm.start(_onOperationComplete(function (err) {
      if (err) return callback(err)

      vm.getMetadata(function (err, metadata) {
        if (err) return callback(err)

        var url = 'http://' + metadata.networkInterfaces[0].accessConfigs[0].natIP
        deployStream.emit('start', url)
        deployStream.url = url

        callback(null, vm)
      })
    }))
  }

  return deployStream
}

// helper to wait for an operation to complete before executing the callback
// this also supports creation callbacks, specifically `createVM`, which has an
// extra arg with the instance object of the created VM
function _onOperationComplete (callback) {
  return function (err, operation, apiResponse) {
    if (err) return callback(err)

    if (arguments.length === 4) {
      var object = operation
      operation = apiResponse
    }

    operation.onComplete(function (err, metadata) {
      if (object) callback(err, object, metadata)
      else callback(err, metadata)
    })
  }
}
