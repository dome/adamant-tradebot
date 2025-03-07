const crypto = require('crypto');
const axios = require('axios');

const {
  trimAny,
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://bitkub-openapi.github.io/
 */

// Error codes: https://bitkub-openapi.github.io/en/#error-message
const httpErrorCodeDescriptions = {
  400: 'Invalid request format',
  401: 'Invalid API Key',
  404: 'Service not found',
  429: 'Too many visits',
  500: 'Internal server error',
};

module.exports = function() {
  let WEB_BASE = 'https://api.bitkub.com';
  let config = {
    apiKey: '',
    secret_key: '',
    tradePwd: '',
  };
  let log = {};

  /**
   * Handles response from API
   * @param {Object} responseOrError
   * @param resolve
   * @param reject
   * @param {String} bodyString
   * @param {String} queryString
   * @param {String} url
   */
  const handleResponse = (responseOrError, resolve, reject, queryString, url) => {
    const httpCode = responseOrError?.status ?? responseOrError?.response?.status;
    const httpMessage = responseOrError?.statusText ?? responseOrError?.response?.statusText;

    const data = responseOrError?.data ?? responseOrError?.response?.data;
    const success = httpCode === 200 && +data.error === 0;
    const error = {
      code: data?.error ?? 'No error code',
      msg: data?.msg ?? data?.message ?? 'No error message',
    };

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data);
      } else {
        const bitkubErrorInfo = `[${error.code}] ${trimAny(error.msg, ' .')}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${bitkubErrorInfo}` : String(responseOrError);

        if (typeof data === 'object') {
          data.bitkubErrorInfo = bitkubErrorInfo;
        }

        if (httpCode === 200) {
          log.log(`Bitkub processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);
          resolve(data);
        } else {
          const errorDescription = httpErrorCodeDescriptions[httpCode] ?? 'Unknown error';

          log.warn(`Request to ${url} with data ${reqParameters} failed. ${errorDescription}, details: ${errorMessage}. Rejecting…`);

          reject(errorMessage);
        }
      }
    } catch (error) {
      log.warn(`Error while processing response of request to ${url} with data ${reqParameters}: ${error}. Data object I've got: ${JSON.stringify(data)}.`);
      reject(`Unable to process data: ${JSON.stringify(data)}. ${error}`);
    }
  };

  /**
   * Makes a request to private (auth) endpoint
   * @param {String} type Request type: get, post, delete
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;

    const bodyString = getParamsString(data);
    const stringifiedData = JSON.stringify(data);

    const timestamp = Date.now();

    const signPayload = type === 'post' ? `${timestamp}POST${path}${stringifiedData}` : `${timestamp}GET${path}?${bodyString}`;

    const sign = getSignature(config.secret_key, signPayload);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'X-BTK-APIKEY': config.apiKey,
          'X-BTK-TIMESTAMP': timestamp,
          'X-BTK-SIGN': sign,
        },
      };

      if (type === 'post') {
        httpOptions.data = stringifiedData;
      } else {
        httpOptions.params = data;
      }

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, bodyString, url))
          .catch((error) => handleResponse(error, resolve, reject, bodyString, url));
    });
  }

  /**
   * Makes a request to public endpoint
   * @param {String} type Request type: get, post, delete
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function publicRequest(type, path, params) {
    const url = `${WEB_BASE}${path}`;

    const queryString = getParamsString(params);

    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        params,
        method: type,
        timeout: 10000,
      };

      axios(httpOptions)
          .then((response) => handleResponse(response, resolve, reject, queryString, url))
          .catch((error) => handleResponse(error, resolve, reject, queryString, url));
    });
  }

  /**
   * Get a signature for a Bitkub request
   * https://bitkub-openapi.github.io/en/#signature-authentication
   * @param {String} secret API secret key
   * @param {Number} timestamp Unix timestamp
   * @param {String} payload Data to sign
   * @returns {String}
   */
  function getSignature(secret, payload) {

    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');
  }

  const EXCHANGE_API = {
    setConfig(apiServer, apiKey, secretKey, tradePwd, logger, publicOnly = false) {
      if (apiServer) {
        WEB_BASE = apiServer;
      }

      if (logger) {
        log = logger;
      }

      if (!publicOnly) {
        config = {
          apiKey,
          tradePwd,
          secret_key: secretKey,
        };
      }
    },

    /**
     * Get user assets balance
     * https://bitkub-openapi.github.io/en/index.html#assets-balance
     * @return {Promise<Array>}
     */
    getBalances() {
      return protectedRequest('post', '/api/v3/market/balances', {});
    },

    /**
     * Get current order v2 version
     * https://bitkub-openapi.github.io/en/index.html#get-current-orders-v2
     * @param {String} symbol In Bitkub format as BTCUSDT
     * @return {Promise<Array>}
     */
    getOrders(symbol) {
      const params = {
        sym: symbol,
      };

      return protectedRequest('get', '/api/v3/market/my-open-orders', params);
    },

    getOrdersHistory(symbol, page, limit) {
      const params = {
        sym: symbol,
        p: page,
        lmt: limit
      };

      return protectedRequest('get', '/api/v3/market/my-open-orders', params);
    },

    /**
     * Get order information v2
     * https://bitkub-openapi.github.io/en/index.html#get-order-information-v2
     * @param {String} orderId Example: '1771215607820588'
     * @returns {Promise<Array>}
     */
    async getOrder(orderId) {
      const params = {
        hash: orderId,
      };

      return protectedRequest('get', '/api/v3/market/order-info', params);
    },

        /**
     * Get order information v2
     * https://bitkub-openapi.github.io/en/index.html#get-order-information-v2
     * @param {String} orderId Example: '1771215607820588'
     * @returns {Promise<Array>}
     */

    /**
     * Create order
     * https://bitkub-openapi.github.io/en/index.html#create-order
     * @param {String} symbol In Bitkub format as BTCUSDT
     * @param {String} amount Base coin amount
     * @param {String} quote Quote coin amount
     * @param {String} price Order price
     * @param {String} side buy or sell
     * @param {String} type market or limit
     * @return {Promise<Object>}
     */
    /*
    addOrder(symbol, amount, quote, price, side, type) {
      const data = {
        symbol,
        side: side.toUpperCase(),
        ordType: type.toUpperCase(),
        ordPrice: +price,
        timestamp: Date.now(),
      };

      if (type === 'market' && side === 'buy') {
        data.ordAmt = +quote;
      } else if ((type === 'market' && side === 'sell') || type === 'limit') {
        data.ordQty = +amount;
      }

      return protectedRequest('post', '/api/trade/order/place', data);
    },
*/
    addOrder(symbol, amount, quote, price, side, type) {
      const data = {
        sym: symbol,
        typ: type.toLowerCase(),
        rat: type.toLowerCase()=='market'?0:+price,
      };

      if (side === 'buy') {
        data.amt = +quote;
        return protectedRequest('post', '/api/v3/market/place-bid', data);
      }else{
        data.amt = +amount;
        return protectedRequest('post', '/api/v3/market/place-ask', data);
      }

      
    },

    /**
     * Cancel orders
     * https://bitkub-openapi.github.io/en/index.html#cancel-orders
     * @param {String} orderId Example: '1771215607820588'
     * @param {String} symbol In Bitkub format as BTCUSDT
     * @return {Promise<Object>}
     */
    cancelOrder(orderId) {
      const data = {
        hash: orderId,
      };

      return protectedRequest('post', '/api/v3/market/cancel-order', data);
    },

    /**
     * Cancel all order for specific symbol
     * https://bitkub-openapi.github.io/en/index.html#one-click-cancellation
     * @param {String} symbol In Bitkub format as BTCUSDT
     * @return {Promise<Array>}
     */
    cancelAllOrders(symbol) {
      const data = {
        symbol,
      };

      return protectedRequest('post', '/api/trade/order/cancelAll', data);
    },

    /**
     * Ticker for all trading pairs in the market
     * https://bitkub-openapi.github.io/en/index.html#ticker
     * @return {Promise<Array>}
    */
    ticker() {
      return publicRequest('get', '/api/v3/market/ticker', {});
    },

    /**
     * Get depth data
     * https://bitkub-openapi.github.io/en/index.html#get-depth
     * @param {String} symbol In Bitkub format as BTCUSDT
     * @return {Promise<Object>}
     */
    orderBook(symbol) {
      const params = {
        sym: symbol,
        lmt: 100, //limit
      };

      return publicRequest('get', `/api/v3/market/depth`, params);
    },

    /**
     * Get the latest trades record
     * https://bitkub-openapi.github.io/en/index.html#latest-trades
     * @param {String} symbol In Bitkub format as BTCUSDT
     * @return {Promise<Array>}
     */
    getTradesHistory(symbol) {
      const params = {
        sym: symbol,
        lmt: 100, //limit
      };

      return publicRequest('get', `/api/v3/market/trades`, params);
    },

  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
