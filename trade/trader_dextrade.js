const DexTradeApi = require('./api/dextrade_api');
const config = require('../modules/configReader');
const utils = require('../helpers/utils');

/**
 * API endpoints:
 * https://api.dex-trade.com/v1/private
 */
const apiServer = 'https://api.dex-trade.com/v1';
const exchangeName = 'DexTrade';

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
  const dextradeApiClient = DexTradeApi();


  dextradeApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

  const ORDER_SIDE = {
    0: 'buy', 1: 'sell'
  }

  const ORDER_SIDE2 = {
    'buy': 0, sell: 1
  }

  const ORDER_TYPE = {
    0: 'limit', 
    1: 'market',
    2: 'limit',
    3: 'market',
    4: 'limit',
  }

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
    if (module.exports.exchangeMarkets) return module.exports.exchangeMarkets[pair ? formatPairName(pair).pairPlain : pair];

    module.exports.gettingMarkets = true;

    return new Promise((resolve) => {
      dextradeApiClient.symbols().then((markets) => {
        try {
          const result = {};

          if(!markets.data){
            log.warn(`API request getMarkets() of ${utils.getModuleName(module.id)} module failed... ${error}`);
            resolve(undefined);
          }

          for (const market of markets.data) {
            //const pairNames = formatPairName(market.symbol);

            result[market.pair] = {
              pairReadable: `${market.base}/${market.quote}`,
              pairPlain: market.pair,
              coin1: market.base,
              coin2: market.quote,
              coin1Decimals: +market.base_decimal,
              coin2Decimals: +market.quote_decimal,
              coin1Precision: utils.getPrecision(+market.base_decimal),
              coin2Precision: utils.getPrecision(+market.quote_decimal),
              coin1MinAmount: null,
              coin1MaxAmount: null,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: null,
              status: null,
              pairId: market.id,
            };
          }

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
     * @param pair In readable format as BTC/USDT or in DexTrade format as BTCUSDT
     * @returns {Promise<*>|*}
     */
    marketInfo(pair) {
      return getMarkets(pair);
    },

    /**
     * Features available on DexTrade exchange
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
        balances = await dextradeApiClient.getBalances();
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];
        const available = balances.data.list.filter((crypto) => crypto.balance > 0);
        available.forEach((crypto) => {
          result.push({
            code: crypto.currency.iso3.toUpperCase(),
            free: +crypto.balance_available,
            freezed: +0,
            total: +crypto.balances.total,
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
        orders = await dextradeApiClient.getOrders();

      } catch (error) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];

        orders.data.list.forEach((order) => {
          if(coinPair.pairPlain == order.pair){
            let orderStatus;

            // https://dextrade-openapi.github.io/en/index.html#dictionary
            if (order.volume_done == 0) {
              orderStatus = 'new';
            } else if (order.volume == order.volume_done) {
              orderStatus = 'filled';
            } else {
              orderStatus = 'part_filled';
            }  

            result.push({
              orderId: order.id.toString(),
              symbol: coinPair.pairReadable,
              symbolPlain: order.pair,
              price: +order.rate, // limit price
              side: ORDER_SIDE[order.type], // 'buy' or 'sell'
              type: ORDER_TYPE[order.type_trade], // 'limit', 'market', 'post_only'
              timestamp: +order.time_create,
              amount: +order.volume,
              amountExecuted: +order.volume_done, // quantity filled in base currency
              amountLeft: +order.volume-order.volume_done, // quantity left in base currency
              status: orderStatus,
            });
          }
          
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
        order = await dextradeApiClient.getOrder(orderId);
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (!order.dextradeErrorInfo) {
          order = order.data;
          let orderStatus;
          // https://dextrade-openapi.github.io/en/index.html#dictionary
          if (order.volume_done == 0) {
            orderStatus = 'new';
          } else if (order.volume == order.volume_done) {
            orderStatus = 'filled';
          } else {
            orderStatus = 'part_filled';
          } 

          const result = {
            orderId: order.id.toString(), // According to docs, an order can have status 'NOT_FOUND'
            tradesCount: undefined, // DexTrade doesn't provide trades
            price: +order.rate, // limit price
            side: ORDER_SIDE[order.type], // 'buy' or 'sell'
            type: ORDER_TYPE[order.type_trade], // 'limit', 'market', 'post_only'
            amount: +order.volume, // In coin1
            volume: +order.price,
            pairPlain: order.pair,
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: undefined, // DexTrade doesn't provide fee info
            amountExecuted: +order.volume_done, // In coin1
            volumeExecuted: +order.price_done, // In coin2
            timestamp: +order.time_create, // in milliseconds
            updateTimestamp: +order.time_done,
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = order.dextradeErrorInfo || 'No details.';
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
     * DexTrade supports both limit and market orders
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

      const markets = this.markets;
      const marketInfo = markets[coinPair.pairPlain];
      //const marketInfo = this.marketInfo(pair);
      
      let message;

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

        coin1Amount = parseFloat(coin1Amount);

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

        price = parseFloat(price);
      }


      let orderType;
      let output = '';

      if (limit) {
        orderType = 0;
        if (coin2Amount) {
          output = `${side} ${coin1Amount} ${coinPair.coin1} for ${coin2Amount} ${coinPair.coin2} at ${price} ${coinPair.coin2}.`;
        } else {
          output = `${side} ${coin1Amount} ${coinPair.coin1} for ${coin2AmountCalculated} ${coinPair.coin2} at ${price} ${coinPair.coin2}.`;
        }
      } else {
        orderType = 1;
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
        response = await dextradeApiClient.addOrder(orderType, ORDER_SIDE2[side], price, coin1Amount, coinPair.pairPlain);

        
        
        //response = await dextradeApiClient.addOrder(coinPair.pairPlain, coin1Amount, coin2Amount, price, side, orderType);

        errorMessage = response?.dextradeErrorInfo;
        orderId = response?.data?.id;
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
     * @param {String} side Not used for DexTrade
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await dextradeApiClient.cancelOrder(orderId, coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.status) {
          // Note: You can cancel already cancelled order
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;
        } else {
          const errorMessage = order?.dextradeErrorInfo ?? 'No details';
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
    /*
    async cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await dextradeApiClient.cancelAllOrders(coinPair.pairPlain);
      } catch (error) {
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
          const errorMessage = orders?.state ?? orders?.dextradeErrorInfo ?? 'No details';
          log.log(`Unable to cancel orders on ${coinPair.pairReadable} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelAllOrders(${paramString}) request result: ${JSON.stringify(orders)}. ${error}`);
        return undefined;
      }
    },*/

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
        ticker = await dextradeApiClient.ticker(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }
      

      let orderBookData;
      try {
        orderBookData = await dextradeApiClient.orderBook(coinPair.pairPlain);
      } catch (err) {
        log.warn(`API request getRates-orderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${err}`);
        return undefined;
      }


      try {

        ticker = ticker.data;
        return {
          ask: +orderBookData.data.sell[0]?.rate,
          bid: +orderBookData.data.buy[0]?.rate,
          last: +ticker.last,
          volume: +ticker.volume_24H,
          volumeInCoin2: null,
          high: +ticker.high,
          low: +ticker.low,
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
        book = await dextradeApiClient.orderBook(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = {
          bids: [],
          asks: [],
        };

        book.data.sell.forEach((crypto) => {
          result.asks.push({
            amount: +crypto.volume,
            price: +crypto.rate,
            count: +crypto.count,
            type: 'ask-sell-right',
          });
        });
        result.asks.sort((sell, buy) => {
          return parseFloat(sell.price) - parseFloat(buy.price);
        });

        book.data.buy.forEach((crypto) => {
          result.bids.push({
            amount: +crypto.volume,
            price: +crypto.rate,
            count: crypto.count,
            type: 'bid-buy-left',
          });
        });
        result.bids.sort((sell, buy) => {
          return parseFloat(buy.price) - parseFloat(sell.price);
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
        trades = await dextradeApiClient.getTradesHistory(coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        const result = [];
        
        trades.data.forEach((trade) => {
          result.push({
            coin1Amount: +trade.volume, // amount in coin1
            price: +trade.rate, // trade price
            coin2Amount: +trade.price, // quote in coin2
            date: +trade.timestamp, // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade.type?.toLowerCase(), // 'buy' or 'sell'
            tradeId: null,  // DexTrade doesn't provide tradeId
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
 * Returns pair in DexTrade format like 'BTCUSDT'
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
    pair: `${coin1}${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: `${coin1}${coin2}`,
  };
}
