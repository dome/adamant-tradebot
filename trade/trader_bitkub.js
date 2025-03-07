const BitkubApi = require('./api/bitkub_api');
const config = require('../modules/configReader');
const utils = require('../helpers/utils');
const e = require('express');

/**
 * API endpoints:
 * https://api.bitkub.com/api
 */
const apiServer = 'https://api.bitkub.com';
const exchangeName = 'Bitkub';

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
  const bitkubApiClient = BitkubApi();

  bitkubApiClient.setConfig(apiServer, apiKey, secretKey, pwd, log, publicOnly);

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
      bitkubApiClient.ticker().then((markets) => {
        try {
          const result = {};

          for(let market of markets){
            const pairNames = formatPairName(market.symbol);
            const coin1Decimals = 8;
            const coin2Decimals = 2;
            result[market.symbol] = {
              pairReadable: pairNames.pairReadable,
              pairPlain: pairNames.pairPlain,
              coin1: pairNames.coin1,
              coin2: pairNames.coin2,
              coin1Decimals: coin1Decimals,
              coin2Decimals: coin2Decimals,
              coin1Precision: utils.getPrecision(coin1Decimals),
              coin2Precision: utils.getPrecision(coin2Decimals),
              coin1MinAmount: null,
              coin1MaxAmount: null,
              coin2MinPrice: null,
              coin2MaxPrice: null,
              minTrade: null,
              status: market.isFrozen==0 ? 'ONLINE' : 'OFFLINE',
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
     * Getter for stored currencies info
     * @return {Object}
     */
    get currencies() {
      return module.exports.exchangeCurrencies;
    },

    /**
     * Get info for a specific market
     * @param pair In readable format as BTC/USDT or in Bitkub format as BTCUSDT
     * @returns {Promise<*>|*}
     */
    marketInfo(pair) {
      return getMarkets(pair);
    },

    /**
     * Features available on Bitkub exchange
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
        balances = await bitkubApiClient.getBalances();
      } catch (error) {
        log.warn(`API request getBalances(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        
        let result = [];

        for(let balance_symbol in balances.result){
          const crypto = balances.result[balance_symbol];
          result.push({
            code: balance_symbol.toUpperCase(),
            free: +crypto.available,
            freezed: +crypto.reserved,
            total: +crypto.available + +crypto.reserved,
          });
        }

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
        orders = await bitkubApiClient.getOrders(coinPair.pair);
      } catch (error) {
        log.warn(`API request getOpenOrders(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];

        for(let order of orders.result){
        //orders.result.forEach(async (order) => {
          let orderStatus;
          const order_detail = await bitkubApiClient.getOrder(order.hash);
          const order_detail_data = order_detail.result;
          if(order_detail_data.partial_filled){
            orderStatus = 'part_filled';
          }else if(order_detail_data.status == 'unfilled'){
            orderStatus = 'new';
          }else if(order_detail_data.status == 'filled'){
            orderStatus = 'filled';
          }else if(order_detail_data.status == 'cancelled'){        
            orderStatus = 'cancelled';
          }else{
            orderStatus = 'unknown';
          }
          const side = order.side?.toLowerCase();
          result.push({
            orderId: order.hash,
            symbol: coinPair.pair,
            symbolPlain: coinPair.pairPlain,
            price: +order.rate, // limit price
            side: side, // 'buy' or 'sell'
            type: (order_detail_data.post_only===true)?'post_only': order.type.toLowerCase(), // 'limit', 'market', 'post_only'
            timestamp: +order.ts,
            amount: (side=='buy')?+(+order.amount/+order.rate):+order.amount,
            amountExecuted: (side=='buy')?+(+order_detail_data.filled/+order.rate):+order_detail_data.filled, 
            amountLeft: (side=='buy')?+(+order_detail_data.remaining/+order.rate):+order_detail_data.remaining, 
            status: orderStatus,
          });
        }
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

      let order;

      const coinPair = formatPairName(pair);

      try {
        const order_detail = await bitkubApiClient.getOrder(orderId);
        if(order_detail){
          order = order_detail.result;
        }
        
      } catch (error) {
        log.warn(`API request getOrderDetails(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
        
      }

      try {
        if (!order.bitkubErrorInfo) {

          const orders = await bitkubApiClient.getOrders(coinPair.pair);
          let order_find;
          orders.result.forEach(async (oo) => {
            if(oo.hash == orderId){
              order_find = oo;
            }
          })
          if(!order_find){
            let o_history = [1];
            let page = 1;
            const limit = 100;
            let processing = true;
            let start_last = false;
            while(processing){
              const history = await bitkubApiClient.getOrdersHistory(coinPair.pair, page, limit);
              o_history = history.result;
              o_history.forEach(async (oh) => {
                if(oh.hash == orderId){
                  order_find = oh;
                }
              });
              if(order_find){
                break;
              }
              if(page === 1){
                if(start_last){
                  break;
                }
                page = history.pagination.last;
                start_last = true;
              }else{
                page = history.pagination.prev;
              }
              

            }
          }
          if(!order_find){
            log.error(`Unable to get order ${orderId} details: Order not found.`);
            return {
              orderId,
              status: 'unknown', // Order doesn't exist or Wrong orderId
            };
          }

          let orderStatus;

          if(order.partial_filled){
            orderStatus = 'part_filled';
          }else if(order.status == 'unfilled'){
            orderStatus = 'new';
          }else if(order.status == 'filled'){
            orderStatus = 'filled';
          }else if(order.status == 'cancelled'){        
            orderStatus = 'cancelled';
          }else{
            orderStatus = 'unknown';
          }

          const side = order_find.side?.toLowerCase();

          const updateTimestamp = order_find.history?.length ? Math.max(...order_find.history?.map(entry => entry.timestamp)): order_find.ts;

          const result = {
            orderId: orderId,
            tradesCount: undefined, // Bitkub doesn't provide trades
            price: +order.rate, // limit price
            side: side, // 'buy' or 'sell'

            type: (order.post_only===true)?'post_only': order_find.type.toLowerCase(),// 'limit', 'market', 'post_only'
            amount: (side=='buy')?+(+order.amount/+order.rate):+order.amount, // In coin1
            volume: (side=='buy')?+order.amount: +(+order.amount*+order.rate),
            pairPlain: coinPair.pairPlain,
            pairReadable: coinPair.pairReadable,
            totalFeeInCoin2: order.fee, // Bitkub doesn't provide fee info
            amountExecuted: (side=='buy')?+(+order.filled/+order.rate):order.filled, // In coin1
            volumeExecuted: (side=='buy')?+order.filled: +(+order.filled*+order.rate), // In coin2
            timestamp: +order_find.ts, // in milliseconds
            // when order.orderUpdateTime = order.timestamp, they are in milliseconds
            // else, order.orderUpdateTime is in seconds, need to multiply by 1000 to get milliseconds
            updateTimestamp: +updateTimestamp,
            status: orderStatus,
          };

          return result;
        } else {
          const errorMessage = order.bitkubErrorInfo || 'No details.';
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
     * Bitkub supports both limit and market orders
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
        response = await bitkubApiClient.addOrder(coinPair.pair, coin1Amount, coin2Amount, price, side, orderType);
        errorMessage = response?.bitkubErrorInfo;
        orderId = response?.result?.hash;
      } catch (error) {
        message = `API request addOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}.`;
        log.warn(message);
        order.orderId = false;
        order.message = message;

        return order;
      }

      if (orderId) {
        message = `Order placed to ${output} Order Id (hash): ${orderId}.`;
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
     * @param {String} side Not used for Bitkub
     * @param {String} pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     */
    async cancelOrder(orderId, side, pair) {
      const paramString = `orderId: ${orderId}, side: ${side}, pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let order;

      try {
        order = await bitkubApiClient.cancelOrder(orderId, coinPair.pairPlain);
      } catch (error) {
        log.warn(`API request cancelOrder(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        if (order.error === 0) {
          log.log(`Cancelling order ${orderId} on ${pair} pair…`);
          return true;

        } else {
          const errorMessage = order?.state ?? order?.bitkubErrorInfo ?? 'No details';
          log.log(`Unable to cancel order ${orderId} on ${pair} pair: ${errorMessage}.`);
          return false;
        }
      } catch (error) {
        log.warn(`Error while processing cancelOrder(${paramString}) request results: ${JSON.stringify(order)}. ${error}`);
        return undefined;
      }
    },

    /**
     * Cancel all order on specific pair No function on bitkub
     * @param pair In classic format as BTC/USDT
     * @returns {Promise<Boolean|undefined>}
     *//*
    async cancelAllOrders(pair) {
      const paramString = `pair: ${pair}`;
      const coinPair = formatPairName(pair);

      let orders;

      try {
        orders = await bitkubApiClient.cancelAllOrders(coinPair.pairPlain);
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
          const errorMessage = orders?.state ?? orders?.bitkubErrorInfo ?? 'No details';
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
        ticker = await bitkubApiClient.ticker();
      } catch (error) {
        log.warn(`API request getRates(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }
      try {
        ticker = ticker.find((t) => t.symbol === coinPair.pair);

        return {
          ask: +ticker.lowest_ask,
          bid: +ticker.highest_bid,
          last: +ticker.last,
          volume: +ticker.base_volume,
          volumeInCoin2: +ticker.quote_volume,
          high: +ticker.high_24_hr,
          low: +ticker.low_24_hr,
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
        book = await bitkubApiClient.orderBook(coinPair.pair);
      } catch (error) {
        log.warn(`API request getOrderBook(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      book = book.result
      try {
        const result = {
          bids: [],
          asks: [],
        };

        book.asks.forEach((crypto) => {
          result.asks.push({
            amount: +crypto[1],
            price: +crypto[0],
            count: 1,
            type: 'ask-sell-right',
          });
        });
        result.asks.sort((a, b) => {
          return parseFloat(a.price) - parseFloat(b.price);
        });

        book.bids.forEach((crypto) => {
          result.bids.push({
            amount: +crypto[1],
            price: +crypto[0],
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
        trades = await bitkubApiClient.getTradesHistory(coinPair.pair);
      } catch (error) {
        log.warn(`API request getTradesHistory(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }
      trades = trades.result;
      try {
        const result = [];

        trades.forEach((trade) => {
          result.push({
            coin1Amount: +trade[2], // amount in coin1
            price: +trade[1], // trade price
            coin2Amount: +trade[2] * +trade[1], // quote in coin2
            date: +trade[0], // must be as utils.unixTimeStampMs(): 1641121688194 - 1 641 121 688 194
            type: trade[3].toLowerCase(), // 'buy' or 'sell'
            //tradeId: trade.tradeId?.toString(),
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

    /**
     * Get trading fees for account
     * @param coinOrPair e.g., 'ETH' or 'ETH/USDT'. If not set, get info for all trade pairs
     * @return {Promise<Array|undefined>}
     *//*
    async getFees(coinOrPair) {
      const paramString = `coinOrPair: ${coinOrPair}`;

      let coinPair;
      let coin;
      if (coinOrPair?.includes('/')) {
        coinPair = formatPairName(coinOrPair);
      } else {
        coin = coinOrPair?.toUpperCase();
      }

      let data;

      try {
        data = await bitkubApiClient.currencies();
      } catch (error) {
        log.warn(`API request getFees(${paramString}) of ${utils.getModuleName(module.id)} module failed. ${error}`);
        return undefined;
      }

      try {
        let result = [];
        for (const coin in data) {
          const currency = data[coin];
          result.push({
            pair: coin,
            makerRate: +currency.maker_fee,
            takerRate: +currency.taker_fee,
          });
        }

        if (coinPair) {
          result = result.filter((pair) => pair.pair === coinPair.coin1);
        } else if (coin) {
          result = result.filter((pair) => pair.pair === coin);
        }

        return result;
      } catch (error) {
        log.warn(`Error while processing getFees(${paramString}) request result: ${JSON.stringify(data)}. ${error}`);
        return undefined;
      }
    },
    */
  };
};

/**
 * Returns pair in Bitkub format like 'BTCUSDT'
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
    pair: `${coin1}_${coin2}`,
    pairReadable: `${coin1}/${coin2}`,
    pairPlain: `${coin1}${coin2}`,
  };
}
