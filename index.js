'use strict'

var archiver = require('archiver')
var assign = require('deep-assign')
var async = require('async')
var format = require('string-format-obj')
var gcloud = require('gcloud')
var multiline = require('multiline')
var outputStream = require('gce-output-stream')
var path = require('path')
var pumpify = require('pumpify')
var slug = require('slug')
var through = require('through2')

var resolveConfig = function (pkg, explicitConfig) {
  var config = {
    root: process.cwd(),
    nodeVersion: '0',

    gcloud: {
      projectId: process.env.GCLOUD_PROJECT_ID,
      keyFile: process.env.GCLOUD_KEY_FILE
    },

    vm: {
      zone: process.env.GCLOUD_ZONE || 'us-central1-a',
      os: 'centos',
      http: true,
      https: true
    }
  }

  assign(config, pkg.gcloudDeploy, explicitConfig)

  // gcloud wants `keyFilename`
  config.gcloud.keyFilename = config.gcloud.keyFile
  delete config.gcloud.keyFile

  if (!config.gcloud.projectId) {
    throw new Error('A projectId is required')
  }

  if (!config.gcloud.credentials && !config.gcloud.keyFilename) {
    throw new Error('Authentication with a credentials object or keyFile path is required')
  }

  return config
}

module.exports = function (config) {
  if (typeof config !== 'object') config = { root: config || process.cwd() }

  var pkg = require(path.join(config.root, 'package.json'))
  config = resolveConfig(pkg, config)

  var gcloudConfig = config.gcloud
  var pkgRoot = config.root

  var gcloudInstance = gcloud(gcloudConfig)
  var gcs = gcloudInstance.storage()
  var gce = gcloudInstance.compute()

  var deployStream = pumpify()

  async.waterfall([
    createTarStream,
    uploadTar,
    createVM,
    startVM
  ], function (err, vm) {
    if (err) return deployStream.destroy(err)

    var outputCfg = assign({}, gcloudConfig, { name: vm.name, zone: vm.zone.name })
    deployStream.setPipeline(outputStream(outputCfg), through())
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
      export NVM_DIR=/usr/local/nvm
      curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.29.0/install.sh | bash
      source /usr/local/nvm/nvm.sh
      nvm install v{version}
      mkdir /opt/app && cd $_
      curl https://storage.googleapis.com/{bucketName}/{fileName} | tar -xz
      npm install
      npm start &
    */}), { bucketName: file.bucket.name, fileName: file.name, version: config.nodeVersion })

    var vmCfg = config.vm

    vmCfg.metadata = vmCfg.metadata || {}
    vmCfg.metadata.items = vmCfg.metadata.items || []
    vmCfg.metadata.items.push({ key: 'startup-script', value: startupScript })

    var zone = gce.zone(vmCfg.zone)

    var onVMReady = function (vm) {
      deployStream.emit('vm', vm)
      deployStream.vm = vm

      callback(null, vm)
    }

    if (vmCfg.name) {
      // re-use an existing VM
      // @tood implement `setMetadata` in gcloud-node#vm
      var vm = zone.vm(vmCfg.name)
      vm.setMetadata(function (err) {
        if (err) return callback(err)
        onVMReady(vm)
      })
    } else {
      // create a VM
      var vmName = slug(pkg.name) + '-' + Date.now()
      zone.createVM(vmName, vmCfg, _onOperationComplete(function (err, vm) {
        if (err) return callback(err)
        onVMReady(vm)
      }))
    }
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
