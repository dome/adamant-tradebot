const crypto = require('crypto');
const axios = require('axios');

const {
  trimAny,
  getParamsString,
} = require('../../helpers/utils');

/**
 * Docs: https://dextrade-openapi.github.io/
 */

// Error codes: https://dextrade-openapi.github.io/en/#error-message
const httpErrorCodeDescriptions = {
  400: 'Invalid request format',
  401: 'Invalid API Key',
  404: 'Service not found',
  429: 'Too many visits',
  500: 'Internal server error',
};

module.exports = function() {
  let WEB_BASE = 'https://api.dex-trade.com/v1';
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
    const success = httpCode === 200 && +data.code === 0;

    const error = {
      code: data?.code ?? 'No error code',
      msg: data?.msg ?? data?.message ?? 'No error message',
    };

    const reqParameters = queryString || '{ No parameters }';

    try {
      if (success) {
        resolve(data.data);
      } else {
        const coinstoreErrorInfo = `[${error.code}] ${trimAny(error.msg, ' .')}`;
        const errorMessage = httpCode ? `${httpCode} ${httpMessage}, ${coinstoreErrorInfo}` : String(responseOrError);

        if (typeof data === 'object') {
          data.coinstoreErrorInfo = coinstoreErrorInfo;
        }

        if (httpCode === 200) {
          log.log(`DexTrade processed a request to ${url} with data ${reqParameters}, but with error: ${errorMessage}. Resolving…`);
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
  function sortObjectKeys(obj) {
    const sortedKeys = Object.keys(obj).sort();
    return sortedKeys.reduce((result, key) => {
      result[key] = obj[key];
      return result;
    }, {});
  }

  function findValues(obj) {
    const results = [];
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const value = obj[key];
        if (typeof value === 'object') {
          results.push(...findValues(value));
        } else if ((value)) {
          results.push(value);
        }
      }
    }
    return results;
  }


  /**
   * Makes a request to private (auth) endpoint
   * @param {String} type Request type: get, post, delete
   * @param {String} path Endpoint
   * @param {Object} data Request params
   * @returns {*}
   */
  function protectedRequest(type, path, data) {
    const url = `${WEB_BASE}${path}`;
    const sortedData = sortObjectKeys(data);
    const signPayload = findValues(sortedData);


    const timestamp = Date.now();

    console.log(signPayload);
    const sign = getSignature(config.secret_key, timestamp, signPayload);
    const bodyString = { ...data, request_id: timestamp };
    console.log(sign);
    return new Promise((resolve, reject) => {
      const httpOptions = {
        url,
        method: type,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'login-token': config.apiKey,
          'x-auth-sign': sign,
        },
      };

      if (type === 'post') {
        httpOptions.data = bodyString;
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
   * Get a signature for a DexTrade request
   * https://dextrade-openapi.github.io/en/#signature-authentication
   * @param {String} secret API secret key
   * @param {Number} timestamp Unix timestamp
   * @param {String} payload Data to sign
   * @returns {String}
   */
  function getSignature(secret, timestamp, payload) {
    const hash = crypto.createHash('sha256');
    hash.update(payload + timestamp + secret);
    return hash.digest('hex');
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
     * https://dextrade-openapi.github.io/en/index.html#assets-balance
     * @return {Promise<Array>}
     */
    getBalances() {
      const data = {};
      return protectedRequest('post', '/private/balances', data);
    },

    /**
     * Get current order v2 version
     * https://dextrade-openapi.github.io/en/index.html#get-current-orders-v2
     * @param {String} symbol In DexTrade format as BTCUSDT
     * @return {Promise<Array>}
     */
    getOrders(symbol) {
      const params = {
        symbol,
      };

      return protectedRequest('post', '/private/orders', params);
    },

    /**
     * Get order information v2
     * https://dextrade-openapi.github.io/en/index.html#get-order-information-v2
     * @param {String} orderId Example: '1771215607820588'
     * @returns {Promise<Array>}
     */
    async getOrder(orderId) {
      const params = {
        ordId: orderId,
      };

      return protectedRequest('get', '/api/v2/trade/order/orderInfo', params);
    },

    /**
     * Create order
     * https://dextrade-openapi.github.io/en/index.html#create-order
     * @param {String} symbol In DexTrade format as BTCUSDT
     * @param {String} amount Base coin amount
     * @param {String} quote Quote coin amount
     * @param {String} price Order price
     * @param {String} side buy or sell
     * @param {String} type market or limit
     * @return {Promise<Object>}
     */
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

    /**
     * Cancel orders
     * https://dextrade-openapi.github.io/en/index.html#cancel-orders
     * @param {String} orderId Example: '1771215607820588'
     * @param {String} symbol In DexTrade format as BTCUSDT
     * @return {Promise<Object>}
     */
    cancelOrder(orderId, symbol) {
      const data = {
        ordId: orderId,
        symbol,
      };

      return protectedRequest('post', '/api/trade/order/cancel', data);
    },

    /**
     * Cancel all order for specific symbol
     * https://dextrade-openapi.github.io/en/index.html#one-click-cancellation
     * @param {String} symbol In DexTrade format as BTCUSDT
     * @return {Promise<Array>}
     */
    cancelAllOrders(symbol) {
      const data = {
        symbol,
      };

      return protectedRequest('post', '/api/trade/order/cancelAll', data);
    },

    /**
     * List currencies
     * DexTrade's docs doesn't describe this endpoint
     * Returned data is not full and doesn't include decimals, precision, min amounts, etc
     * @return {Promise<Object>}
     */
    currencies() {
      return publicRequest('get', '/v3/public/assets', {});
    },

    /**
     * Ticker for all trading pairs in the market
     * https://dextrade-openapi.github.io/en/index.html#ticker
     * @return {Promise<Array>}
    */
    ticker() {
      return publicRequest('get', '/public/symbols', {});
    },

    /**
     * Get depth data
     * https://dextrade-openapi.github.io/en/index.html#get-depth
     * @param {String} symbol In DexTrade format as BTCUSDT
     * @return {Promise<Object>}
     */
    orderBook(symbol) {
      const params = {
        depth: 100, // The number of depths, such as "5, 10, 20, 50, 100", default 20
      };

      return publicRequest('get', `/public/book?pair=${symbol}`, params);
    },

    /**
     * Get the latest trades record
     * https://dextrade-openapi.github.io/en/index.html#latest-trades
     * @param {String} symbol In DexTrade format as BTCUSDT
     * @return {Promise<Array>}
     */
    getTradesHistory(symbol) {
      const params = {
        size: 100, // Number of data bars, [1,100]
      };

      return publicRequest('get', `/api/v1/market/trade/${symbol}`, params);
    },

  };

  return EXCHANGE_API;
};

module.exports.axios = axios; // for setup axios mock adapter
