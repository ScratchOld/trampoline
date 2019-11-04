const https = require('https');
const request = require('request');
const logger = require('../logger');
const APIError = require('./APIError');

/**
 * @typedef {(err: any, body: any) => void} RequestCallback
 */

/**
 * @typedef QueuedRequest
 * @property {string} url
 * @property {any} options
 * @property {RequestCallback} callback
 */

/**
 * A queue of Web Requests, processed on a set timer.
 */
class RequestQueue {
  /**
   * @param {number} throttle The time, in milliseconds, between requests.
   */
  constructor(throttle) {
    /** @type {QueuedRequest[]} */
    this.backlog = [];
    /** The time that the most recent request was initiated */
    this.lastRequest = 0;
    /** Whether the Queue is currently processing requests, or waiting for a request to be queued. */
    this.processing = false;
    /** The time in milliseconds between requests. */
    this.throttle = throttle;
    /** Maximum number of requests that can be queued. */
    this.maxBacklog = 100;
  }

  now() {
    return Date.now();
  }

  timeSinceLastRequest() {
    return this.now() - this.lastRequest;
  }

  timeUntilNextRequest() {
    return Math.max(this.throttle - this.timeSinceLastRequest(), 0);
  }

  backlogEmpty() {
    return this.backlog.length === 0;
  }

  backlogFilled() {
    return this.backlog.length >= this.maxBacklog;
  }

  getHeaders() {
    return {};
  }

  processNextRequest() {
    if (this.backlogEmpty()) {
      throw new APIError.InternalError('Cannot process next request: nothing in queue');
    }
    const { url, callback, options } = this.backlog.shift();
    this.lastRequest = this.now();
    request.get(url, this.getRequestOptions(options), (err, res, body) => {
      if (err) {
        callback(new APIError.InternalError(err.code + ': ' + err.message), null);
        return;
      }

      switch (res.statusCode) {
        case 200: callback(null, body); break;
        case 404: callback(new APIError.NotFound('Resource does not exist'), null); break;
        default: callback(new APIError.UpstreamError('HTTP Status Code: ' + res.statusCode), null); break;
      }

      logger.debug('RequestQueue: processed request: ms', this.timeSinceLastRequest(), 'status', res.statusCode, 'next', this.timeUntilNextRequest());
      if (this.backlogEmpty()) {
        this.stopProcessingRequests();
      } else {
        this.scheduleNextRequest(this.timeUntilNextRequest());
      }
    });
  }

  getRequestOptions(options) {
    const headers = this.getHeaders();
    return {
      ...options,
      headers,
      agent: RequestQueue.requestAgent,
    };
  }

  scheduleNextRequest(delay) {
    setTimeout(() => this.processNextRequest(), delay);
  }

  beginProcessingRequests() {
    this.processing = true;
    this.scheduleNextRequest(this.timeUntilNextRequest());
  }

  stopProcessingRequests() {
    this.processing = false;
  }

  /**
   * Queue a request.
   * @param {string} url 
   * @param {any} options 
   * @param {RequestCallback} callback 
   */
  queue(url, options, callback) {
    logger.debug('RequestQueue: queue url:', url, 'backlog size:', this.backlog.length);
    if (this.backlogFilled()) {
      callback(new APIError.TooManyRequests('Request backlog is filled.'), null);
      return;
    }
    this.backlog.push({ url: url, options: options, callback: callback });
    if (!this.processing) {
      this.beginProcessingRequests();
    }
  }

  /**
   * Promise-based wrapper for queue()
   * @param {string} url 
   * @param {any} options 
   */
  queuePromise(url, options) {
    return new Promise((resolve, reject) => {
      this.queue(url, options, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }
}

RequestQueue.requestAgent = new https.Agent({ keepAlive: true });

module.exports = RequestQueue;
