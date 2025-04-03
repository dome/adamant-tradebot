const BitqikApi = require('./api/bitqik_api');
const config = require('../modules/configReader');
const utils = require('../helpers/utils');

/**
 * API endpoints:
 * https://api.bitqik.com/api
 */
const apiServer = 'https://api.bitqik.com/spot';
const exchangeName = 'Bitqik';
const ORDER_TYPE = {
  76: 'limit',
  77: 'market',
}

const ORDER_STATUS = { 
  2: 'new',
  5: 'part_filled',
  4: 'filled',
  9: 'new',
  6: 'cancelled',
};

module.exports = (
    apiKey,
    secretKey,
    pwd,
    log,
    publicOnly = false,
    loadMarket = true,
    useSocket = false,
    useSocketPull = false,
    accountNo = 0,
    coin1 = config.coin1,
    coin2 = config.coin2,
) => {
  const bitqikApiClient = BitqikApi();

  bitqikApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  // Fulfill markets on initialization
  if (loadMarket) {
    getMarkets();
  }


  /**
   * Get info on all markets and store in module.exports.exchangeMarkets
   * It's an internal function, not called outside of this module
   * @param {String} pair In classic format as BTC/USDT. If markets are already cached, get info for the pair.
   * @returns {Promise<unknown>|*}
   */
  function getMarkets(pair) {
    const paramString = `pair: ${pair}`;

    if (module.exports.gettingMarkets) return;
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair ? formatPairName(pair).pair : pair];

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      bitqikApiClient.ticker().then((markets) => {
        try {
          const result = {};

          markets.forEach((market) => {
            const maxCoin1Decimals = utils.getDecimalsFromNumber(market.minOrderSize);
  
            const maxCoin2Decimals = utils.getDecimalsFromNumber(market.minValidPrice);
            const current_pair = formatPairName(market.symbol);
            result[market.symbol] = {
              pairReadable: current_pair.pairReadable,
              pairPlain: current_pair.pairPlain,
              coin1: current_pair.coin1,
              coin2: current_pair.coin2,
              coin1Decimals: maxCoin1Decimals,
              coin2Decimals: maxCoin2Decimals,
              coin1Precision: utils.getPrecision(maxCoin1Decimals),
              coin2Precision: utils.getPrecision(maxCoin2Decimals),
              coin1MinAmount: market.minOrderSize,
              coin1MaxAmount: market.maxOrderSize,
              coin2MinPrice: market.minValidPrice,
              coin2MaxPrice: null,
              minTrade: null,
              status: null,
            };
          });

          if (Object.keys(result).length > 0) {
            module.exports.exchangeMarkets = result;
            log.log(`Received info about ${Object.keys(result).length} markets on ${exchangeName} exchange.`);
          }

          resolve(result);
        } catch (error) {
          log.warn(`Error while processing getMarkets(${paramString}) request: ${error}`);
          resolve(undefined);
        }
      }).catch((error) => {
        log.warn(`API request getMarkets() of ${utils.getModuleName(module.id)} module failed. ${error}`);
        resolve(undefined);
      }).finally(() => {
        module.exports.gettingMarkets = false;
      });
    });
  }

  return {
    getMarkets,

    /**
     * Getter for stored markets info
     * @return {Object}
     */
    get markets() {
      return module.exports.exchangeMarkets;
    },
    /**
     * Get info for a specific market
     * @param pair In readable format as BTC/USDT or in Bitqik format as BTCUSDT
     * @returns {Promise<*>|*}
     */
    marketInfo(pair) {
      return getMarkets(pair);
    },

    /**
     * Features available on Bitqik exchange
     * @returns {Object}
     */
    features() {
      return {
        getMarkets: true,
        getCurrencies: false,
        placeMarketOrder: true,
        allowAmountForMarketBuy: false,
        getDepositAddress: false,
        createDepositAddressWithWebsiteOnly: true,
        getTradingFees: false,
        getAccountTradeVolume: false,
        getFundHistory: false,
        getFundHistoryImplemented: false,
      };
    },

    /**
     * Get user balances
     * @param {Boolean} nonzero Return only non-zero balances
     * @returns {Promise<Array|undefined>}
     */
    async getBalances(nonzero = true) {
      const paramString = `nonzero: ${nonzero}`;

      let balances;

      try {
        balances = await bitqikApiClient.getBalances();
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];

        balances.forEach((balance) => {
          result.push({
            code: balance.currency.toUpperCase(),
            free: +balance.available,
            freezed: +balance.total - +balance.available,
            total: +balance.total,
          });
        });

        if (nonzero) {
          result = result.filter((crypto) => crypto.free || crypto.freezed);
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getBalances(${paramString}) request results: ${JSON.stringify(balances)}. ${error}`);
        return undefined;
      }
    },

    /**
     * List of all account open orders
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Array|undefined>}
     */
    async getOpenOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await bitqikApiClient.getOrders(coinPair.pair);
      } catch (error) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

 
      try {
        const result = [];

        orders.forEach((order) => {
          let orderStatus;

          if(order.orderState === 'STATUS_INACTIVE') {
            orderStatus = 'cancelled';
          }else{
            if(order.filledSize === 0) {
              orderStatus = 'new';
            }else if(order.filledSize > 0 && order.filledSize < order.size) {
              orderStatus = 'part_filled';
            }else if(order.filledSize === order.size) {
              orderStatus = 'filled';
            }
          }
          const orderCoinPair = formatPairName(order.symbol);

          result.push({
            orderId: order.orderID,
            symbol: order.symbol,
            symbolPlain: orderCoinPair.pairPlain,
            price: +order.price, // limit price
            side: order.side.toLowerCase(), // 'buy' or 'sell'
            type: ORDER_TYPE[order.orderType], // 'limit', 'market', 'post_only'
            timestamp: +order.timestamp,
            amount: +order.size,
            amountExecuted: +order.filledSize, // quantity filled in base currency
            amountLeft: +order.size - +order.filledSize, // quantity left in base currency
            status: orderStatus,
          });
        });

        return result;
      } catch (error) {
        log.warn(`Error while processing getOpenOrders(${paramString}) request results: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get specific order details
     * What's important is to understand the order was filled or closed by other reason
     * status: unknown, new, filled, part_filled, cancelled
     * @param {String} orderId Example: '1771215607820588'
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderDetails(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);
      let order;

      try {
        order = await bitqikApiClient.getOrder(orderId);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (!order.bitqikErrorInfo) {
          const result = {
            orderId: order.orderID, // According to docs, an order can have status 'NOT_FOUND'
            tradesCount: undefined, // Bitqik doesn't provide trades
            price: +order.price, // limit price
            side: order.side?.toLowerCase(), // 'buy' or 'sell'
            type: ORDER_TYPE[order.orderType], // 'limit', 'market', 'post_only'
            amount: +order.size, // In coin1
            volume: +order.orderValue,
            pairPlain: coinPair.pairPlain,
            pairReadable: `${coinPair.coin1}/${coinPair.coin2}`,
            totalFeeInCoin2: undefined, // Bitqik doesn't provide fee info
            amountExecuted: +order.filledSize, // In coin1
            volumeExecuted: +order.filledSize * +order.size, // In coin2
            timestamp: +order.timestamp, // in milliseconds
            updateTimestamp: +order.timestamp,
            status: ORDER_STATUS[order.status] || 'cancelled',
          };

          return result;
        } else {
          const errorMessage = order.bitqikErrorInfo || 'No details.';
          log.log(`Unable to get order ${orderId} details: ${JSON.stringify(errorMessage)}. Returning unknown order status.`);

          return {
            orderId,
            status: 'unknown', // Order doesn't exist or Wrong orderId
          };
        }
      } catch (error) {
        log.warn(`Error while processing getOrderDetails(${paramString}) request results: ${JSON.stringify(order)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Places an order
     * Bitqik supports both limit and market orders
     * Market Buy is only possible with quote coin amount specified
     * Market Sell is only possible with base coin amount specified
     * @param {String} side 'buy' or 'sell'
     * @param {String} pair In classic format like BTC/USD
     * @param {Number} price Order price
     * @param {Number} coin1Amount Base coin amount. Provide either coin1Amount or coin2Amount.
     * @param {Number} limit 1 if order is limit (default), 0 in case of market order
     * @param {Number} coin2Amount Quote coin amount. Provide either coin1Amount or coin2Amount.
     * @returns {Promise<Object>|undefined}
     */
    async placeOrder(side, pair, price, coin1Amount, limit = 1, coin2Amount) {
      const paramString = `side: ${side}, pair: ${pair}, price: ${price}, coin1Amount: ${coin1Amount}, limit: ${limit}, coin2Amount: ${coin2Amount}`;

      const coinPair = formatPairName(pair);

      const marketInfo = this.marketInfo(pair);

      let message;

      console.log('marketInfo')
      console.log(marketInfo)
      if (!marketInfo) {
        message = `Unable to place an order on ${exchangeName} exchange. I don't have info about market ${pair}.`;
        log.warn(message);
        return {
          message,
        };
      }

      // for Limit orders, calculate coin1Amount if only coin2Amount is provided
      if (!coin1Amount && coin2Amount && price) {
        coin1Amount = coin2Amount / price;
      }

      // for Limit orders, calculate coin2Amount if only coin1Amount is provided
      let coin2AmountCalculated;
      if (!coin2Amount && coin1Amount && price) {
        coin2AmountCalculated = coin1Amount * price;
      }

      // Round coin1Amount, coin2Amount and price to a certain number of decimal places, and check if they are correct.
      // Note: any value may be small, e.g., 0.000000033. In this case, its number representation will be 3.3e-8.
      // That's why we store values as strings. If an exchange doesn't support string type for values, cast them to numbers.

      if (coin1Amount) {
        coin1Amount = (+coin1Amount).toFixed(marketInfo.coin1Decimals);
        if (!+coin1Amount) {
          message = `Unable to place an order on ${exchangeName} exchange. After rounding to ${marketInfo.coin1Decimals} decimal places, the order amount is wrong: ${coin1Amount}.`;
          log.warn(message);
          return {
            message,
          };
        }
      }

      if (coin2Amount) {
        coin2Amount = (+coin2Amount).toFixed(marketInfo.coin2Decimals);
        if (!+coin2Amount) {
          message = `Unable to place an order on ${exchangeName} exchange. After rounding to ${marketInfo.coin2Decimals} decimal places, the order volume is wrong: ${coin2Amount}.`;
          log.warn(message);
          return {
            message,
          };
        }
      }

      if (price) {
        price = (+price).toFixed(marketInfo.coin2Decimals);
        if (!+price) {
          message = `Unable to place an order on ${exchangeName} exchange. After rounding to ${marketInfo.coin2Decimals} decimal places, the order price is wrong: ${price}.`;
          log.warn(message);
          return {
            message,
          };
        }
      }

      if (+coin1Amount < marketInfo.coin1MinAmount) {
        message = `Unable to place an order on ${exchangeName} exchange. Order amount ${coin1Amount} ${marketInfo.coin1} is less minimum ${marketInfo.coin1MinAmount} ${marketInfo.coin1} on ${marketInfo.pairReadable} pair.`;
        log.warn(message);
        return {
          message,
        };
      }

      if (coin2Amount && +coin2Amount < marketInfo.coin2MinAmount) { // coin2Amount may be null or undefined
        message = `Unable to place an order on ${exchangeName} exchange. Order volume ${coin2Amount} ${marketInfo.coin2} is less minimum ${marketInfo.coin2MinAmount} ${marketInfo.coin2} on ${pair} pair.`;
        log.warn(message);
        return {
          message,
        };
      }

      let orderType;
      let output = '';

      if (limit) {
        orderType = 'limit';
        if (coin2Amount) {
          output = `${side} ${coin1Amount} ${coinPair.coin1} for ${coin2Amount} ${coinPair.coin2} at ${price} ${coinPair.coin2}.`;
        } else {
          output = `${side} ${coin1Amount} ${coinPair.coin1} for ${coin2AmountCalculated} ${coinPair.coin2} at ${price} ${coinPair.coin2}.`;
        }
      } else {
        orderType = 'market';
        if (coin2Amount) {
          output = `${side} ${coinPair.coin1} for ${coin2Amount} ${coinPair.coin2} at Market Price on ${pair} pair.`;
        } else {
          output = `${side} ${coin1Amount} ${coinPair.coin1} at Market Price on ${pair} pair.`;
        }
      }

      const order = {};
      let response;
      let orderId;
      let errorMessage;

      try {
        // eslint-disable-next-line max-len
        response = await bitqikApiClient.addOrder(coinPair.pair, coin1Amount, coin2Amount, price, side, orderType);

        errorMessage = response?.bitqikErrorInfo;
        orderId = response[0]?.orderID;
      } catch (error) {
        message = `API request addOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}.`;
        log.warn(message);
        order.orderId = false;
        order.message = message;

        return order;
      }

      if (orderId) {
        message = `Order placed to ${output} Order Id: ${orderId}.`;
        log.info(message);
        order.orderId = orderId;
        order.message = message;
      } else {
        const details = errorMessage ? ` Details: ${utils.trimAny(errorMessage, ' .')}.` : ' { No details }.';
        message = `Unable to place order to ${output}${details} Check parameters and balances.`;
        log.warn(message);
        order.orderId = false;
        order.message = message;
      }

      return order;
    },

    /**
     * Cancel an order
     * @param {String} orderId Example: '1771215607820588'
     * @param {String} side Not used for Bitqik
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, pair) {
      const paramString = `orderId: ${orderId}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await bitqikApiClient.cancelOrder(orderId, coinPair.pair);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.state === 'CANCELED') {
          if (order.clientOrderId) {
            log.log(`Cancelling order ${orderId} on ${pair} pair…`);
            return true;
          } else {
            log.log(`Order ${orderId} on ${pair} pair is already cancelled.`);
            return false;
          }
        } else {
          const errorMessage = order?.state ?? order?.bitqikErrorInfo ?? 'No details';
          log.log(`Unable to cancel order ${orderId} on ${pair} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelOrder(${paramString}) request results: ${JSON.stringify(order)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Cancel all order on specific pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await bitqikApiClient.cancelAllOrders(coinPair.pair);
      } catch (error) {
        console.log('error')
        console.log(error)
        log.warn(`API request cancelAllOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (orders === undefined) {
          // Returns undefined if no orders cancelled
          log.log(`No active orders on ${coinPair.pairReadable} pair.`);
          return false;
        } else if (orders.canceling) {
          log.log(`Cancelled ${orders.canceling.length} orders on ${coinPair.pairReadable} pair…`);
          return true;
        } else {
          const errorMessage = orders?.state ?? orders?.bitqikErrorInfo ?? 'No details';
          log.log(`Unable to cancel orders on ${coinPair.pairReadable} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelAllOrders(${paramString}) request result: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get info on trade pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getRates(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let ticker;

      try {
        ticker = await bitqikApiClient.ticker();
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        ticker = ticker.find((t) => t.symbol === coinPair.pair);

        return {
          ask: +ticker.lowestAsk,
          bid: +ticker.highestBid,
          last: +ticker.last,
          volume: +ticker.size,
          volumeInCoin2: +ticker.volume,
          high: +ticker.high24Hr,
          low: +ticker.low24Hr,
        };
      } catch (error) {
        log.warn(`Error while processing getRates(${paramString}) request result: ${JSON.stringify(ticker)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get orderbook on a specific pair
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Object|undefined>}
     */
    async getOrderBook(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let book;

      try {
        book = await bitqikApiClient.orderBook(coinPair.pair);
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = {
          bids: [],
          asks: [],
        };

        book.sellQuote.forEach((crypto) => {
          result.asks.push({
            amount: +crypto.size,
            price: +crypto.price,
            count: 1,
            type: 'ask-sell-right',
          });
        });
        result.asks.sort((a, b) => {
          return parseFloat(a.price) - parseFloat(b.price);
        });

        book.buyQuote.forEach((crypto) => {
          result.bids.push({
            amount: +crypto.size,
            price: +crypto.price,
            count: 1,
            type: 'bid-buy-left',
          });
        });
        result.bids.sort((a, b) => {
          return parseFloat(b.price) - parseFloat(a.price);
        });

        return result;
      } catch (error) {
        log.warn(`Error while processing getOrderBook(${paramString}) request result: ${JSON.stringify(book)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Get history of trades
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async getTradesHistory(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let trades;

      try {
        trades = await bitqikApiClient.getTradesHistory(coinPair.pair);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        trades.forEach((trade) => {
          result.push({
            coin1Amount: +trade.size, // amount in coin1
            price: +trade.price, // trade price
            coin2Amount: +trade.size * +trade.price, // quote in coin2
            date: +trade.timestamp, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade.side?.toLowerCase(), // 'buy' or 'sell'
            tradeId: trade.serialId,
          });
        });

        // We need ascending sort order
        result.sort((a, b) => {
          return parseFloat(a.date) - parseFloat(b.date);
        });

        return result;
      } catch (error) {
        log.warn(`Error while processing getTradesHistory(${paramString}) request result: ${JSON.stringify(trades)}. ${error}`);
        return undefined;
      }
    },


  };
};

/**
 * Returns pair in Bitqik format like 'BTCUSDT'
 * @param pair Pair in any format
 * @returns {Object|Boolean} pair, pairReadable, pairPlain, coin1, coin2
*/
function formatPairName(pair) {
  pair = pair.toUpperCase();

  if (pair.indexOf('-') > -1) {
    pair = pair.replace('-', '/').toUpperCase();
  } else if (pair.indexOf('_') !== -1) {
    pair = pair.replace('_', '/').toUpperCase();
  }

  const [coin1, coin2] = pair.split('/');

  return {
    coin1,
    coin2,
    pair: `${coin1}-${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: `${coin1}${coin2}`,
  };
}
