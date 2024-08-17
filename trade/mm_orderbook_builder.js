/**
 * Places to and removes orders from order book in order to make it dynamic
 * Each iteration places up to MAX_ORDERS_PER_ITERATION orders
 * Maximum ob-order number is tradeParams.mm_orderBookOrdersCount
 */

const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const config = require('../modules/configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const tradeParams = require('./settings/tradeParams_' + config.exchange);
const traderapi = require('./trader_' + config.exchange)(
    config.apikey,
    config.apisecret,
    config.apipassword,
    log,
    undefined,
    undefined,
    config.exchange_socket,
    config.exchange_socket_pull,
);
const db = require('../modules/DB');
const orderUtils = require('./orderUtils');
const orderCollector = require('./orderCollector');

let lastNotifyBalancesTimestamp = 0;
let lastNotifyPriceTimestamp = 0;

const INTERVAL_MIN = 1500;
const INTERVAL_MAX = 3000;


// LIFETIME_MAX ~ 30 sec; — depends on mm_orderBookOrdersCount * LIFETIME_KOEF * 1000 * Math.cbrt(position))
// Also depends on traderapi.features().orderNumberLimit
const LIFETIME_MIN = 1500;
const LIFETIME_KOEF = 0.5;

const MAX_ORDERS_PER_ITERATION = 5; // Place up to 5 orders every iteration

let isPreviousIterationFinished = true;

module.exports = {
  readableModuleName: 'Order book builder',

  run() {
    this.iteration();
  },

  async iteration() {
    const interval = setPause();
    if (
      interval &&
      tradeParams.mm_isActive &&
      tradeParams.mm_isOrderBookActive &&
      constants.MM_POLICIES_REGULAR.includes(tradeParams.mm_Policy)
    ) {
      if (isPreviousIterationFinished) {
        isPreviousIterationFinished = false;
        await this.buildOrderBook();
        isPreviousIterationFinished = true;
      } else {
        log.log(`Orderbook builder: Postponing iteration of the order book builder for ${interval} ms. Previous iteration is in progress yet.`);
      }
      setTimeout(() => {
        this.iteration();
      }, interval);
    } else {
      setTimeout(() => {
        this.iteration();
      }, 3000); // Check for config.mm_isActive every 3 seconds
    }
  },

  async buildOrderBook() {
    try {
      const { ordersDb } = db;
      let orderBookOrders = await ordersDb.find({
        isProcessed: false,
        purpose: 'ob', // ob: dynamic order book order
        pair: config.pair,
        exchange: config.exchange,
      });

      orderBookOrders = await orderUtils.updateOrders(orderBookOrders, config.pair, utils.getModuleName(module.id) + ':ob-'); // update orders which partially filled or not found
      orderBookOrders = await this.closeOrderBookOrders(orderBookOrders);

      let ordersToPlace = utils.randomValue(1, MAX_ORDERS_PER_ITERATION, true);
      let orderBookOrdersCount = orderBookOrders.length;
      while (ordersToPlace > 0 && orderBookOrdersCount < tradeParams.mm_orderBookOrdersCount) {
        ordersToPlace--;
        if (await this.placeOrderBookOrder(orderBookOrdersCount)) {
          orderBookOrdersCount++;
        }
      }

      log.log(`Orderbook builder: ${orderBookOrdersCount} ob-orders opened.`);
    } catch (e) {
      log.error(`Error in buildOrderBook() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  },

  /**
   * Closes opened ob-orders:
   * - Expired by time
   * - Out of Pw's range
   * @param {Array of Object} orderBookOrders Orders of type ob, got from internal DB
   * @return {Array of Object} Updated order list
   */
  async closeOrderBookOrders(orderBookOrders) {
    const updatedObOrders = [];

    for (const order of orderBookOrders) {
      try {
        let reasonToClose = ''; const reasonObject = {};
        if (order.dateTill < utils.unixTimeStampMs()) {
          reasonToClose = 'It\'s expired.';
          reasonObject.isExpired = true;
        } else if (utils.isOrderOutOfPriceWatcherRange(order)) {
          const pw = require('./mm_price_watcher');
          reasonToClose = `It's out of ${pw.getPwRangeString()}`;
          reasonObject.isOutOfPwRange = true;
        }

        if (reasonToClose) {
          const cancellation = await orderCollector.clearOrderById(
              order, order.pair, order.type, this.readableModuleName, reasonToClose, reasonObject, traderapi);

          if (!cancellation.isCancelRequestProcessed) {
            updatedObOrders.push(order);
          }
        } else {
          updatedObOrders.push(order);
        }
      } catch (e) {
        log.error(`Error in closeOrderBookOrders() of ${utils.getModuleName(module.id)} module: ` + e);
      }
    }

    return updatedObOrders;
  },

  async placeOrderBookOrder(orderBookOrdersCount) {
    try {
      const type = setType();

      const orderBook = await orderUtils.getOrderBookCached(config.pair, utils.getModuleName(module.id), true);
      if (!orderBook || !orderBook.asks[0] || !orderBook.bids[0]) {
        log.warn(`Orderbook builder: Order books are empty for ${config.pair}, or temporary API error. Unable to check if I need to place ob-order.`);
        return;
      }
      let orderList = type === 'buy' ? orderBook.bids : orderBook.asks;
      // Remove duplicates by 'price' field
      orderList = orderList.filter((order, index, self) =>
        index === self.findIndex((o) => (
          o.price === order.price
        )),
      );
      if (!orderList || !orderList[0] || !orderList[1]) {
        log.warn(`Orderbook builder: Filtered order count of type ${type} is less than 2 for ${config.pair}, or temporary API error. Unable to set a price while placing ob-order.`);
        return;
      }

      const position = setPosition(orderList.length);
      const priceReq = await setPrice(type, position, orderList);
      const price = priceReq.price;
      const coin1Amount = setAmount();
      const coin2Amount = coin1Amount * price;
      const lifeTime = setLifeTime(position);

      let output = '';
      let orderParamsString = '';

      if (!price) {
        if ((Date.now()-lastNotifyPriceTimestamp > constants.HOUR) && priceReq.message) {
          notify(`${config.notifyName}: ${priceReq.message}`, 'warn'); // Currently, there is no priceReq.message
          lastNotifyPriceTimestamp = Date.now();
        }
        return;
      }

      orderParamsString = `type=${type}, pair=${config.pair}, price=${price}, coin1Amount=${coin1Amount}, coin2Amount=${coin2Amount}`;
      if (!type || !price || !coin1Amount || !coin2Amount) {
        log.warn(`Orderbook builder: Unable to run ob-order of ${orderParamsString}.`);
        return;
      }

      // Check balances
      const balances = await isEnoughCoins(config.coin1, config.coin2, coin1Amount, coin2Amount, type);
      if (!balances.result) {
        if (balances.message) {
          if (Date.now()-lastNotifyBalancesTimestamp > constants.HOUR) {
            notify(`${config.notifyName}: ${balances.message}`, 'warn', config.silent_mode);
            lastNotifyBalancesTimestamp = Date.now();
          } else {
            log.log(`Orderbook builder: ${balances.message}`);
          }
        }
        return;
      }

      const orderReq = await traderapi.placeOrder(type, config.pair, price, coin1Amount, 1, null);

      if (orderReq?.orderId) {
        const { ordersDb } = db;

        const order = new ordersDb({
          _id: orderReq.orderId,
          date: utils.unixTimeStampMs(),
          dateTill: utils.unixTimeStampMs() + lifeTime,
          purpose: 'ob', // ob: dynamic order book order
          type,
          // targetType: type,
          exchange: config.exchange,
          pair: config.pair,
          coin1: config.coin1,
          coin2: config.coin2,
          price,
          coin1Amount,
          coin2Amount,
          coin1AmountFilled: undefined,
          coin2AmountFilled: undefined,
          coin1AmountLeft: coin1Amount,
          coin2AmountLeft: coin2Amount,
          LimitOrMarket: 1, // 1 for limit price. 0 for Market price.
          isProcessed: false,
          isExecuted: false,
          isCancelled: false,
          isClosed: false,
        });

        await order.save();

        output = `${type} ${coin1Amount.toFixed(orderUtils.parseMarket(config.pair).coin1Decimals)} ${config.coin1} for ${coin2Amount.toFixed(orderUtils.parseMarket(config.pair).coin2Decimals)} ${config.coin2} at ${price.toFixed(orderUtils.parseMarket(config.pair).coin2Decimals)} ${config.coin2}`;
        output += ` with ${Math.round(lifeTime/1000)} sec life time`;
        log.info(`Orderbook builder: Successfully placed ob-order to ${output}. Open ob-orders: ~${orderBookOrdersCount+1}.`);

        return true;
      } else {
        log.warn(`Orderbook builder: Unable to execute ob-order of ${orderParamsString}. No order id returned.`);
      }
    } catch (e) {
      log.error(`Error in placeOrderBookOrder() of ${utils.getModuleName(module.id)} module: ` + e);
    }
  },
};

/**
 * Determines if to 'buy' or 'sell' for ob-order
 * @returns {String}
*/
function setType() {
  if (!tradeParams || !tradeParams.mm_buyPercent) {
    log.warn(`Orderbook builder: Param mm_buyPercent is not set. Check ${config.exchangeName} config.`);
    return false;
  }

  // 1 minus tradeParams.mm_buyPercent
  const type = Math.random() > tradeParams.mm_buyPercent ? 'buy' : 'sell';
  return type;
}

/**
 * Checks if enough funds to place ob-order
 * @param {String} coin1 = config.coin1 (base)
 * @param {String} coin2 = config.coin2 (quote)
 * @param {Number} amount1 Amount in coin1 (base)
 * @param {Number} amount2 Amount in coin2 (quote)
 * @param {String} type 'buy' or 'sell'
 * @returns {Object<Boolean, String>}
 *  result: if enough funds to place order
 *  message: error message
 */
async function isEnoughCoins(coin1, coin2, amount1, amount2, type) {
  const balances = await orderUtils.getBalancesCached(false, utils.getModuleName(module.id));
  let balance1free; let balance2free;
  let balance1freezed; let balance2freezed;
  let isBalanceEnough = true;
  let output = '';

  if (balances) {
    try {
      balance1free = balances.filter((crypto) => crypto.code === coin1)[0]?.free || 0;
      balance2free = balances.filter((crypto) => crypto.code === coin2)[0]?.free || 0;
      balance1freezed = balances.filter((crypto) => crypto.code === coin1)[0]?.freezed || 0;
      balance2freezed = balances.filter((crypto) => crypto.code === coin2)[0]?.freezed || 0;

      if ((!balance1free || balance1free < amount1) && type === 'sell') {
        output = `Not enough balance to place ${amount1.toFixed(orderUtils.parseMarket(config.pair).coin1Decimals)} ${coin1} ${type} ob-order. Free: ${balance1free.toFixed(orderUtils.parseMarket(config.pair).coin1Decimals)} ${coin1}, frozen: ${balance1freezed.toFixed(orderUtils.parseMarket(config.pair).coin1Decimals)} ${coin1}.`;
        isBalanceEnough = false;
      }
      if ((!balance2free || balance2free < amount2) && type === 'buy') {
        output = `Not enough balance to place ${amount2.toFixed(orderUtils.parseMarket(config.pair).coin2Decimals)} ${coin2} ${type} ob-order. Free: ${balance2free.toFixed(orderUtils.parseMarket(config.pair).coin2Decimals)} ${coin2}, frozen: ${balance2freezed.toFixed(orderUtils.parseMarket(config.pair).coin2Decimals)} ${coin2}.`;
        isBalanceEnough = false;
      }

      // console.log(balance1.toFixed(0), amount1.toFixed(0), balance2.toFixed(8), amount2.toFixed(8));
      return {
        result: isBalanceEnough,
        message: output,
      };

    } catch (e) {
      log.warn('Orderbook builder: Unable to process balances for placing ob-order: ' + e);
      return {
        result: false,
      };
    }
  } else {
    log.warn('Orderbook builder: Unable to get balances for placing ob-order.');
    return {
      result: false,
    };
  }
}

/**
 * Calculates ob-order price
 * It corrects price to fit Pw's range if needed
 * @param {String} type 'buy' or 'sell'
 * @param {Number} position Position in order book to place ob-order
 * @param {Object} orderList Current orders
 * @returns {Object<Number>} price
*/
async function setPrice(type, position, orderList) {
  try {
    let output = '';
    let high; let low;

    if (orderList.length < position) {
      position = orderList.length;
    }

    if (type === 'sell') {
      low = orderList[position-2].price;
      high = orderList[position-1].price;
    } else {
      high = orderList[position-2].price;
      low = orderList[position-1].price;
    }

    const pairObj = orderUtils.parseMarket(config.pair);
    const coin2Decimals = pairObj.coin2Decimals;
    const precision = utils.getPrecision(coin2Decimals);

    // Put orders between current orders, but not with the same price
    if (low + precision < high) {
      low += precision;
    }
    if (high - precision > low) {
      high -= precision;
    }

    let price = utils.randomValue(low, high);
    let pwLowPrice; let pwHighPrice; let priceBeforePwCorrection;

    const pw = require('./mm_price_watcher');

    if (pw.getIsPriceWatcherEnabled()) {
      const orderInfo = `${type} ob-order at ${price.toFixed(coin2Decimals)} ${config.coin2}`;

      if (pw.getIsPriceAnomaly()) {
        log.log(`Orderbook builder: Skipped placing ${orderInfo}. Price watcher reported a price anomaly.`);

        return {
          price: undefined,
        };
      } else if (pw.getIsPriceActual()) {
        pwLowPrice = pw.getLowPrice();
        pwHighPrice = pw.getHighPrice();
      } else {
        if (pw.getIgnorePriceNotActual()) {
          log.log(`Orderbook builder: While placing ${orderInfo}, the Price watcher reported the price range is not actual. According to settings, ignore and treat this like the Pw is disabled.`);
        } else {
          log.log(`Orderbook builder: Skipped placing ${orderInfo}. Price watcher reported the price range is not actual.`);

          return {
            price: undefined,
          };
        }
      }
    }

    if (type === 'sell') {
      if (pwLowPrice && price < pwLowPrice) {
        priceBeforePwCorrection = price;
        const maxVisiblePrice = orderList[tradeParams.mm_orderBookHeight]?.price;
        if (pwLowPrice < maxVisiblePrice) {
          price = utils.randomValue(pwLowPrice, maxVisiblePrice);
        } else {
          price = utils.randomValue(pwLowPrice, maxVisiblePrice * 1.05);
        }
      }
    } else {
      if (pwHighPrice && price > pwHighPrice) {
        priceBeforePwCorrection = price;
        const minVisiblePrice = orderList[tradeParams.mm_orderBookHeight]?.price;
        if (minVisiblePrice < pwHighPrice) {
          price = utils.randomValue(minVisiblePrice, pwHighPrice);
        } else {
          price = utils.randomValue(pwHighPrice * 0.95, pwHighPrice);
        }
      }
    }

    if (priceBeforePwCorrection) {
      output = `Orderbook builder: Price watcher corrected price from ${priceBeforePwCorrection.toFixed(coin2Decimals)} ${config.coin2} to ${price.toFixed(coin2Decimals)} ${config.coin2} while placing ${type} ob-order. ${pw.getPwRangeString()}`;
      log.log(output);
    }

    return {
      price,
    };
  } catch (e) {
    log.error(`Error in setPrice() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

/**
 * Sets randomized order amount
 * @returns {Number} Amount to place order in order book
*/
function setAmount() {
  if (!tradeParams || !tradeParams.mm_maxAmount || !tradeParams.mm_minAmount) {
    log.warn(`Orderbook builder: Params mm_maxAmount or mm_minAmount are not set. Check ${config.exchangeName} config.`);
    return false;
  }

  const min = tradeParams.mm_minAmount;
  let max = tradeParams.mm_maxAmount;
  if (tradeParams.mm_orderBookMaxOrderPercent) {
    max = max * tradeParams.mm_orderBookMaxOrderPercent / 100;
    if (max <= min) {
      max = min * 1.1;
    }
  }
  return utils.randomValue(min, max);
}

/**
 * Sets random ob-order position in order book
 * @param {Number} orderCount Count of order in order book (buy or sell side)
 * @returns {Number}
*/
function setPosition(orderCount) {
  const maxPosition = Math.min(orderCount, tradeParams.mm_orderBookHeight);
  return utils.randomValue(2, maxPosition, true);
}

/**
 * Sets random ob-order lifetime
 * The closer to spread, the lesser life time
 * @param {Number} position Position in order book
 * @returns {Number}
*/
function setLifeTime(position) {
  const lifetimeMax = tradeParams.mm_orderBookOrdersCount * LIFETIME_KOEF * 1000;
  let orderLifeTime = Math.round(utils.randomValue(LIFETIME_MIN, lifetimeMax, false) * Math.cbrt(position));
  if (utils.isPositiveInteger(traderapi.features().orderNumberLimit)) {
    orderLifeTime *= traderapi.features().orderNumberLimit;
  }
  return orderLifeTime;
}

/**
 * Sets interval to review order book in ms
 * @returns {Number}
*/
function setPause() {
  return utils.randomValue(INTERVAL_MIN, INTERVAL_MAX, true);
}
