// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Poll } from '@jupyterlab/coreutils';

import { ArrayExt, IIterator, iter } from '@phosphor/algorithm';

import { JSONExt } from '@phosphor/coreutils';

import { ISignal, Signal } from '@phosphor/signaling';

import { ServerConnection } from '..';

import { Kernel } from './kernel';

// TODO: Migrate kernel connection status etc. up to session
// TODO: move session management work up to session manager rather than session objects
// TODO: Get rid of ClientSession
// TODO: put session persistence in jlab server end (even if not in notebook)

/**
 * An implementation of a kernel manager.
 */
export class KernelManager implements Kernel.IManager {
  /**
   * Construct a new kernel manager.
   *
   * @param options - The default options for kernel.
   */
  constructor(options: KernelManager.IOptions = {}) {
    this.serverSettings =
      options.serverSettings || ServerConnection.makeSettings();

    // Initialize internal data.
    this._ready = (async () => {
      await this.requestRunning();
      if (this.isDisposed) {
        return;
      }
      this._isReady = true;
    })();

    // Start model and specs polling with exponential backoff.
    this._pollModels = new Poll({
      auto: false,
      factory: () => this.requestRunning(),
      frequency: {
        interval: 10 * 1000,
        backoff: true,
        max: 300 * 1000
      },
      name: `@jupyterlab/services:KernelManager#models`,
      standby: options.standby || 'when-hidden'
    });
    void this.ready.then(() => {
      void this._pollModels.start();
    });
  }

  /**
   * The server settings for the manager.
   */
  readonly serverSettings: ServerConnection.ISettings;

  /**
   * Test whether the kernel manager is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Test whether the manager is ready.
   */
  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * A promise that fulfills when the manager is ready.
   */
  get ready(): Promise<void> {
    return this._ready;
  }

  /**
   * A signal emitted when the running kernels change.
   */
  get runningChanged(): ISignal<this, Kernel.IModel[]> {
    return this._runningChanged;
  }

  /**
   * A signal emitted when there is a connection failure.
   */
  get connectionFailure(): ISignal<this, Error> {
    return this._connectionFailure;
  }

  /**
   * Connect to an existing kernel.
   *
   * @param model - The model of the target kernel.
   *
   * @returns A promise that resolves with the new kernel instance.
   */
  connectTo(model: Kernel.IModel): Kernel.IKernel {
    let kernel = Kernel.connectTo(model, this.serverSettings);
    this._onStarted(kernel);
    return kernel;
  }

  /**
   * Dispose of the resources used by the manager.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._models.length = 0;
    this._pollModels.dispose();
    Signal.clearData(this);
  }

  /**
   * Find a kernel by id.
   *
   * @param id - The id of the target kernel.
   *
   * @returns A promise that resolves with the kernel's model.
   */
  findById(id: string): Promise<Kernel.IModel> {
    return Kernel.findById(id, this.serverSettings);
  }

  /**
   * Force a refresh of the running kernels.
   *
   * @returns A promise that resolves when the running list has been refreshed.
   *
   * #### Notes
   * This is not typically meant to be called by the user, since the
   * manager maintains its own internal state.
   */
  async refreshRunning(): Promise<void> {
    await this._pollModels.refresh();
    await this._pollModels.tick;
  }

  /**
   * Create an iterator over the most recent running kernels.
   *
   * @returns A new iterator over the running kernels.
   */
  running(): IIterator<Kernel.IModel> {
    return iter(this._models);
  }

  /**
   * Shut down a kernel by id.
   *
   * @param id - The id of the target kernel.
   *
   * @returns A promise that resolves when the operation is complete.
   *
   * #### Notes
   * This will emit [[runningChanged]] if the running kernels list
   * changes.
   */
  async shutdown(id: string): Promise<void> {
    const models = this._models;
    const kernels = this._kernels;
    const index = ArrayExt.findFirstIndex(models, value => value.id === id);

    if (index === -1) {
      return;
    }

    // Proactively remove the model.
    models.splice(index, 1);
    this._runningChanged.emit(models.slice());

    // Delete and dispose the kernel locally.
    kernels.forEach(kernel => {
      if (kernel.id === id) {
        kernels.delete(kernel);
        kernel.dispose();
      }
    });

    // Shut down the remote session.
    await Kernel.shutdown(id, this.serverSettings);
  }

  /**
   * Shut down all kernels.
   *
   * @returns A promise that resolves when all of the kernels are shut down.
   */
  async shutdownAll(): Promise<void> {
    // Update the list of models then shut down every session.
    try {
      await this.requestRunning();
      await Promise.all(
        this._models.map(({ id }) => Kernel.shutdown(id, this.serverSettings))
      );
    } finally {
      // Dispose every kernel and clear the set.
      this._kernels.forEach(kernel => {
        kernel.dispose();
      });
      this._kernels.clear();

      // Remove all models even if we had an error.
      if (this._models.length) {
        this._models.length = 0;
        this._runningChanged.emit([]);
      }
    }
  }

  /**
   * Start a new kernel.
   *
   * @param options - The kernel options to use.
   *
   * @returns A promise that resolves with the kernel instance.
   *
   * #### Notes
   * The manager `serverSettings` will be always be used.
   */
  async startNew(options: Kernel.IOptions = {}): Promise<Kernel.IKernel> {
    const newOptions = { ...options, serverSettings: this.serverSettings };
    const kernel = await Kernel.startNew(newOptions);
    this._onStarted(kernel);
    return kernel;
  }

  /**
   * Execute a request to the server to poll running kernels and update state.
   */
  protected async requestRunning(): Promise<void> {
    const models = await Kernel.listRunning(this.serverSettings).catch(err => {
      // Check for a network error, or a 503 error, which is returned
      // by a JupyterHub when a server is shut down.
      if (
        err instanceof ServerConnection.NetworkError ||
        (err.response && err.response.status === 503)
      ) {
        this._connectionFailure.emit(err);
        return [] as Kernel.IModel[];
      }
      throw err;
    });
    if (this._isDisposed) {
      return;
    }
    if (!JSONExt.deepEqual(models, this._models)) {
      const ids = models.map(({ id }) => id);
      const kernels = this._kernels;
      kernels.forEach(kernel => {
        if (ids.indexOf(kernel.id) === -1) {
          kernel.dispose();
          kernels.delete(kernel);
        }
      });
      this._models = models.slice();
      this._runningChanged.emit(models);
    }
  }

  /**
   * Handle a kernel starting.
   */
  private _onStarted(kernel: Kernel.IKernel): void {
    let id = kernel.id;
    this._kernels.add(kernel);
    let index = ArrayExt.findFirstIndex(this._models, value => value.id === id);
    if (index === -1) {
      this._models.push(kernel.model);
      this._runningChanged.emit(this._models.slice());
    }
    kernel.disposed.connect(() => {
      this._onTerminated(id);
    });
  }

  /**
   * Handle a kernel terminating.
   */
  private _onTerminated(id: string): void {
    let index = ArrayExt.findFirstIndex(this._models, value => value.id === id);
    if (index !== -1) {
      this._models.splice(index, 1);
      this._runningChanged.emit(this._models.slice());
    }
  }

  private _isDisposed = false;
  private _isReady = false;
  private _kernels = new Set<Kernel.IKernel>();
  private _models: Kernel.IModel[] = [];
  private _pollModels: Poll;
  private _ready: Promise<void>;
  private _runningChanged = new Signal<this, Kernel.IModel[]>(this);
  private _connectionFailure = new Signal<this, Error>(this);
}

/**
 * The namespace for `KernelManager` class statics.
 */
export namespace KernelManager {
  /**
   * The options used to initialize a KernelManager.
   */
  export interface IOptions {
    /**
     * The server settings for the manager.
     */
    serverSettings?: ServerConnection.ISettings;

    /**
     * When the manager stops polling the API. Defaults to `when-hidden`.
     */
    standby?: Poll.Standby;
  }
}
