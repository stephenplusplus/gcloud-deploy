# gcloud-deploy
> Quickly deploy a Node.js project on Google Compute Engine

## CLI
```sh
$ npm install -g gcloud-deploy
$ gcloud-deploy
Backup created: grape-spaceship-123-gcloud-deploy-tars/1444765984324.tar
VM created: my-app-1444765984324
Deployed successfully! http://146.148.48.123
```

## Programmatically
```sh
$ npm install --save gcloud-deploy
```
```js
var gcloudDeploy = require('gcloud-deploy')

// Give it a Node.js project
gcloudDeploy('./')
  // A VM was created (`vm` is a gcloud-node VM object)
  .on('vm', function (vm) {})

  // App is being served at `url`
  .on('start', function (url) {})

  // raw output from the server while it initializes & starts your app
  .pipe(process.stdout)
```

## npm script
```sh
$ npm install --save-dev gcloud-deploy
```
```json
{
  "name": "my-app",
  "devDependencies": {
    "gcloud-deploy": "*"
  },
  "scripts": {
    "deploy": "gcloud-deploy"
  }
}
```
```sh
$ npm run deploy
```


## How it works

This module...

  1. makes a tarball of your project
  1. uploads it to a bucket
  1. creates a Compute Engine instance with a startup script to:
    1. install Node.js v0.12
    1. unpack the tarball
    1. run `npm start`

A `package.json` is required, along with a `gcloud` object to hold configuration for this module. An example `package.json`:

```json
{
  "name": "my-app",
  "version": "0.0.0",
  "dependencies": {
    "express": "^4.13.3"
  },
  "gcloud": {
    "projectId": "grape-spaceship-123",
    "keyFilename": "key.json"
  }
}
```

The `gcloud` object above is the same as what is passed to the [gcloud-node](http://gitnpm.com/gcloud) library. See the [documentation for `config`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0?method=gcloud) to show what properties are expected.


## API

### `gcloudDeploy = require('gcloud-deploy')(projectRoot)`

#### projectRoot
- Type: `String`
- Default: `process.cwd()`

The directory to where the project's `package.json` can be found.

#### gcloudDeploy
- Type: `Stream`

A stream is returned that will **not end unless you end it**. It is a constant pouring of output from the created VM using [gce-output-stream](http://gitnpm.com/gce-output-stream). To end it, just abort the process (easy for the CLI), or programmatically:

```js
gcloudDeploy()
  .on('data', function (outputLine) {
    if (outputLine.indexOf('node server.js') > -1) {
      // Looks like the server started
      // No need to poll for more output
      this.end()
    }
  })
```

##### .on('error', function (err) {})
- Type: `Error`

An error occurred during the deploy process.

##### .on('bucket', function (bucket) {})
- Type: [`Bucket`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/bucket)

A bucket was successfully created (or re-used) to hold the tarball snapshots we take of your project.

*See the [gcloud-node Bucket docs](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/bucket).*

##### .on('file', function (file) {})
- Type: [`File`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/file)

The tarball snapshot of your project was uploaded successfully. After being used by the VM's startup script, it is deleted.

*See the [gcloud-node File docs](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/storage/file).*

##### .on('vm', function (vm) {})
- Type: [`VM`](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/compute/vm)

The VM that was created to host your project. Get the name of the VM from the `name` property (`vm.name`).

*See the [gcloud-node VM docs](https://googlecloudplatform.github.io/gcloud-node/#/docs/v0.23.0/compute/vm).*

##### .on('start', function (url) {})
- Type: `String`

The URL to your project. If your app listens on port 80, you can get right to it from this URL.


## Contributions

Desperately seeking help with the following tasks:

  - Customization of Node.js version to run
  - Customization of VMs to create
  - Allow VMs to be re-used
  - Modularize the startup script (maybe use [this one?](https://github.com/GoogleCloudPlatform/nodejs-getting-started/blob/master/gce/startup-script.sh))
  - Don't make the tarball public
  - Expand CLI to:
    - Show running VMs
    - Stop/start VMs
    - Delete VMs

If you're interested in helping out, please open an issue so our efforts don't collide. Plus, it'd be nice to meet you!
