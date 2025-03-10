const constants = require('../helpers/const');
const utils = require('../helpers/utils');
const exchangerUtils = require('../helpers/cryptos/exchanger');
const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const api = require('./api');

const tradeParams = require('../trade/settings/tradeParams_' + config.exchange);
const traderapi = require('../trade/trader_' + config.exchange)(config.apikey, config.apisecret, config.apipassword, log);
const orderCollector = require('../trade/orderCollector');
const orderStats = require('../trade/orderStats');
const orderUtils = require('../trade/orderUtils');

const timeToConfirm = 1000 * 60 * 10; // 10 minutes to confirm
const pendingConfirmation = {
  command: '',
  timestamp: 0,
};

const previousBalances = [
  {}, // balances of the first trade account
  {}, // balances of the second trade account
  {}, // sum of balances for both trade accounts
];
/*
  accountNo -> userId -> balances object
  {
    userId: {
      timestamp,
      balances: balances for userId/senderId @timestamp
    }
  }
*/

const previousOrders = [
  {}, // orders of the first trade account
  {}, // orders of the second trade account
];

module.exports = async (commandMsg, tx, itx) => {
  let commandResult = {};

  try {
    const from = tx.senderTgUsername ?
      `${tx.senderTgUsername} (message ${tx.id})` :
      `${tx.senderId} (transaction ${tx.id})`;

    log.log(`Processing '${commandMsg}' command from ${from}…`);

    let group = commandMsg
        .trim()
        .replace(/ {2,}/g, ' ')
        .split(' ');
    let commandName = group.shift().trim().toLowerCase().replace('/', '');

    const alias = aliases[commandName];
    if (alias) {
      log.log(`Alias '${commandMsg}' converted to command '${alias(group)}'`);
      group = alias(group)
          .trim()
          .replace(/ {2,}/g, ' ')
          .split(' ');
      commandName = group.shift().trim().toLowerCase().replace('/', '');
    }

    const command = commands[commandName];

    if (command) {
      commandResult = await command(group, tx, itx?.commandFix); // commandFix if for /help only
    } else {
      commandResult.msgSendBack = `I don’t know */${commandName}* command. ℹ️ You can start with **/help**.`;
    }

    if (commandResult.msgNotify) {
      notify(`${commandResult.msgNotify} Action is executed by ${from}.`, commandResult.notifyType);
    }

    if (itx) {
      await itx.update({ isProcessed: true }, true);
    }

    if (commandName !== 'y') {
      utils.saveConfig(false, `After-commandTxs(/${commandName})`);
    }
  } catch (e) {
    tx = tx || {};

    if (tx.senderTgUsername) {
      log.error(`Error while processing ${commandMsg} command from ${tx.senderTgUsername} (message ${tx.id}). Error: ${e.toString()}`);
    } else {
      log.error(`Error while processing ${commandMsg} command from ${tx.senderId} (transaction ${tx.id}). Error: ${e.toString()}`);
    }
  }

  return commandResult;
};

/**
 * Get pair rates info from an exchange
 * @param {String} pair Trade pair to request
 * @returns {Object} success, exchangeRates, ratesString
 */
async function getRatesInfo(pair) {
  let exchangeRates;
  let ratesString;
  let success;

  try {
    const pairObj = orderUtils.parseMarket(pair);
    const coin2 = pairObj.coin2;
    const coin2Decimals = pairObj.coin2Decimals;

    exchangeRates = await traderapi.getRates(pairObj.pair);

    if (exchangeRates) {
      const delta = exchangeRates.ask-exchangeRates.bid;
      const average = (exchangeRates.ask+exchangeRates.bid)/2;
      const deltaPercent = delta/average * 100;

      ratesString = `${config.exchangeName} rates for ${pair} pair:`;
      ratesString += `\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}, spread: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      if (exchangeRates.last) {
        ratesString += ` Last price: _${(exchangeRates.last).toFixed(coin2Decimals)}_ ${coin2}.`;
      }

      success = true;
    } else {
      ratesString = `Unable to get ${config.exchangeName} rates for ${pairObj.pair}.`;
      success = false;
    }
  } catch (e) {
    log.error(`Error in getRatesString() of ${utils.getModuleName(module.id)} module: ` + e);
    ratesString = `Unable to process ${config.exchangeName} rates for ${pair}.`;
    success = false;
  }

  return {
    success,
    exchangeRates,
    ratesString,
  };
}

/**
 * Set a command to be confirmed
 * @param {String} command This command will be executed with /y
 */
async function setPendingConfirmation(command) {
  try {
    pendingConfirmation.command = command;
    pendingConfirmation.timestamp = Date.now();
    log.log(`Pending command to confirm: ${command}.`);
  } catch (e) {
    log.error(`Error in setPendingConfirmation() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

/**
 * Command to confirm pending command, set with setPendingConfirmation()
 * @param {Array of String} params Doesn't matter
 * @param {Object} tx Information about initiator
 * @return {Object} commandResult.msgSendBack to reply
 */
async function y(params, tx) {
  try {
    if (pendingConfirmation.command) {
      let commandResult = {
        msgNotify: '',
        msgSendBack: '',
        notifyType: 'log',
      };

      if (Date.now() - pendingConfirmation.timestamp > timeToConfirm) {
        commandResult.msgSendBack = `I will not confirm command ${pendingConfirmation.command} as it is expired. Try again.`;
      } else {
        commandResult = await module.exports(`${pendingConfirmation.command} -y`, tx);
        commandResult.msgNotify = ''; // Command itself will notify, we need only msgSendBack
      }

      pendingConfirmation.command = '';

      return commandResult;
    } else {
      return {
        msgNotify: '',
        msgSendBack: 'There is no pending command to confirm.',
        notifyType: 'log',
      };
    }
  } catch (e) {
    log.error(`Error in y()-confirmation of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

function start(params) {
  const type = params[0]?.toLowerCase();
  if (!['mm'].includes(type)) {
    return {
      msgNotify: '',
      msgSendBack: 'Indicate trade type, _mm_ for market making. Example: */start mm*.',
      notifyType: 'log',
    };
  }

  if (['-y', '-Y'].includes(params[1])) {
    params[1] = '';
  }
  const newPolicy = (params[1] || tradeParams.mm_Policy || 'optimal').toLowerCase();
  if (!constants.MM_POLICIES.includes(newPolicy)) {
    return {
      msgNotify: '',
      msgSendBack: `Wrong market making policy. It may be ${constants.MM_POLICIES.join(', ')}. Example: */start mm spread*.`,
      notifyType: 'log',
    };
  }

  let msgNotify; let msgSendBack;

  if (type === 'mm') {
    if (tradeParams.mm_isPriceMakerActive === true && tradeParams.mm_Policy === 'depth' && newPolicy !== 'depth') {
      const pw = require('../trade/mm_price_watcher');
      pw.restorePw(`User> Market making policy changed from depth to ${newPolicy}`);
    }

    tradeParams.mm_isActive = true;
    tradeParams.mm_Policy = newPolicy;

    const notesStringMsg = ' Check enabled options with */params* command.';

    msgNotify = `${config.notifyName} set to start market making with ${newPolicy} policy for ${config.pair}.`;
    msgSendBack = `Starting market making with ${newPolicy} policy for ${config.pair} pair.${notesStringMsg}`;

    return {
      msgNotify,
      msgSendBack,
      notifyType: 'log',
    };
  }
}

function stop(params) {
  const type = params[0]?.toLowerCase();
  if (!['mm'].includes(type)) {
    return {
      msgNotify: '',
      msgSendBack: 'Indicate trade type, _mm_ for market making. Example: */stop mm*.',
      notifyType: 'log',
    };
  }

  let msgNotify; let msgSendBack;

  if (type === 'mm') {
    const optionsString = ', order book building, liquidity and spread maintenance, price watching and other options';

    if (tradeParams.mm_isActive) {
      msgNotify = `${config.notifyName} stopped Market making${optionsString} for ${config.pair} pair.`;
      msgSendBack = `Market making${optionsString} for ${config.pair} pair are disabled now.`;
    } else {
      msgNotify = '';
      msgSendBack = `Market making for ${config.pair} pair is not active.`;
    }

    tradeParams.mm_isActive = false;
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

/**
 * Validate if the bot has a specific feature
 * @param {String} feature Feature to enable or disable
 * @param {String} action 'enable' or 'disable'
 * @returns {Object} { validated, msgSendBack }
 */
function validateFeature(feature, action) {
  const botFeatures = {
    ob: 'dynamic order book building',
    liq: 'liquidity and spread maintenance',
    pw: 'price watching',
  };

  let featureDescription = Object.entries(botFeatures)
      .map(([key, value]) => `\n_${key}_ for ${value}`)
      .join(', ');
  featureDescription = utils.trimAny(featureDescription, ', ') + '.';

  let msgSendBack = 'Indicate option:\n';
  msgSendBack += featureDescription;
  msgSendBack += action === 'enable' ? '\n\nExample: */enable ob 15*.' : '\n\nExample: */disable ob*.';

  const validated = Object.keys(botFeatures).includes(feature);

  return {
    validated,
    msgSendBack,
  };
}

async function enable(params, {}, isWebApi = false) {
  let msgNotify; let msgSendBack; let infoString; let infoStringSendBack = ''; let optionsString;

  try {
    const type = params[0]?.toLowerCase();
    const typeValidation = validateFeature(type, 'enable');
    if (!typeValidation.validated) {
      return {
        msgNotify: '',
        msgSendBack: typeValidation.msgSendBack,
        notifyType: 'log',
      };
    }

    if (type === 'ob') {

      const pairObj = orderUtils.parseMarket(config.pair);

      let orderBookOrdersCount = +params[1];
      if (params[1] && !utils.isPositiveNumber(orderBookOrdersCount)) {
        return {
          msgNotify: '',
          msgSendBack: 'Set correct ob-order count. Example: */enable ob 15 20%*.',
          notifyType: 'log',
        };
      }
      if (utils.isPositiveNumber(orderBookOrdersCount)) {
        tradeParams.mm_orderBookOrdersCount = orderBookOrdersCount;
      } else if (!tradeParams.mm_orderBookOrdersCount) {
        orderBookOrdersCount = constants.DEFAULT_ORDERBOOK_ORDERS_COUNT;
      }

      const maxOrderPercentParam = params[2];
      let maxOrderPercent;
      if (maxOrderPercentParam) {
        const percentSign = maxOrderPercentParam.slice(-1);
        maxOrderPercent = +maxOrderPercentParam.slice(0, -1);
        if (!utils.isPositiveNumber(maxOrderPercent) || percentSign !== '%') {
          return {
            msgNotify: '',
            msgSendBack: `Set correct max ob-order amount percent from market-making max order (currently _${tradeParams.mm_maxAmount.toFixed(pairObj.coin1Decimals)} ${pairObj.coin1}_). Example: */enable ob 15 20%*.`,
            notifyType: 'log',
          };
        }
      } else {
        maxOrderPercent = 100;
      }

      tradeParams.mm_isOrderBookActive = true;
      tradeParams.mm_orderBookMaxOrderPercent = maxOrderPercent;

      infoString = '';
      let infoStringPercent = '';
      optionsString = 'Order book building';
      if (tradeParams.mm_orderBookMaxOrderPercent === 100) {
        infoStringPercent = ` and same max order amount as market-making (currently _${tradeParams.mm_maxAmount.toFixed(pairObj.coin1Decimals)} ${pairObj.coin1}_)`;
      } else {
        const maxAgOrderAmount = tradeParams.mm_orderBookMaxOrderPercent * tradeParams.mm_maxAmount / 100;
        infoStringPercent = ` and max order amount of _${tradeParams.mm_orderBookMaxOrderPercent}%_ from market-making max order, _~${maxAgOrderAmount.toFixed(pairObj.coin1Decimals)} ${pairObj.coin1}_ currently`;
      }
      infoString = ` with _${tradeParams.mm_orderBookOrdersCount}_ maximum number of orders${infoStringPercent}`;

    } else if (type === 'liq') {

      // Parse ±depth%
      const spreadString = params[1];
      if (!spreadString || (spreadString.slice(-1) !== '%')) {
        return {
          msgNotify: '',
          msgSendBack: 'Set a spread in percentage. Example: */enable liq 2% 1000 ADM 50 USDT uptrend*.',
          notifyType: 'log',
        };
      }
      const spreadValue = +spreadString.slice(0, -1);
      if (!spreadValue || spreadValue === Infinity || spreadValue <= 0 || spreadValue > 80) {
        return {
          msgNotify: '',
          msgSendBack: 'Set correct spread in percentage. Example: */enable liq 2% 1000 ADM 50 USDT uptrend*.',
          notifyType: 'log',
        };
      }

      // Parse liquidity value
      const coin1 = params[3]?.toUpperCase();
      const coin2 = params[5]?.toUpperCase();
      if (
        !coin1 || !coin2 || coin1 === coin2 ||
        (![config.coin1, config.coin2].includes(coin1)) || (![config.coin1, config.coin2].includes(coin2))
      ) {
        return {
          msgNotify: '',
          msgSendBack: `Incorrect liquidity coins. Config is set to trade ${config.pair} pair. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
          notifyType: 'log',
        };
      }

      const coin1Amount = +params[2];
      if (!utils.isPositiveOrZeroNumber(coin1Amount)) {
        return {
          msgNotify: '',
          msgSendBack: `Incorrect ${coin1} amount: ${coin1Amount}. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
          notifyType: 'log',
        };
      }

      const coin2Amount = +params[4];
      if (!utils.isPositiveOrZeroNumber(coin2Amount)) {
        return {
          msgNotify: '',
          msgSendBack: `Incorrect ${coin2} amount: _${coin2Amount}_. Example: */enable liq 1.5-2% 100 ${config.coin1} 50 ${config.coin2} ss uptrend*.`,
          notifyType: 'log',
        };
      }

      let trend = params[6];
      if (!trend) {
        trend = 'middle';
      }

      trend = trend.toLowerCase();
      if ((!['middle', 'downtrend', 'uptrend'].includes(trend))) {
        return {
          msgNotify: '',
          msgSendBack: `Incorrect trend. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
          notifyType: 'log',
        };
      }

      if (coin1 === config.coin1) {
        tradeParams.mm_liquiditySellAmount = coin1Amount;
        tradeParams.mm_liquidityBuyQuoteAmount = coin2Amount;
      } else {
        tradeParams.mm_liquiditySellAmount = coin2Amount;
        tradeParams.mm_liquidityBuyQuoteAmount = coin1Amount;
      }

      tradeParams.mm_liquidityTrend = trend;
      tradeParams.mm_liquiditySpreadPercent = spreadValue;
      tradeParams.mm_isLiquidityActive = true;

      if (trend === 'middle') {
        trend = 'middle trend';
      }
      infoString = ` with _${tradeParams.mm_liquiditySellAmount} ${config.coin1}_ asks (sell) and _${tradeParams.mm_liquidityBuyQuoteAmount} ${config.coin2}_ bids (buy) within _${spreadValue}%_ spread & _${trend}_`;
      optionsString = 'Liquidity and spread maintenance';

      await require('../trade/mm_liquidity_provider').resetLiqLimits('all', 'CommandTxs/NewLiquiditySet');

    } else if (type === 'pw') {

      const coin2Decimals = orderUtils.parseMarket(config.pair).coin2Decimals;

      const generalExample = 'Example: */enable pw 0.1—0.2 USDT* or */enable pw ADM/USDT@Azbit 0.5% smart prevent*.';

      const pwSourceInput = params[1];
      if (!pwSourceInput) {
        return {
          msgNotify: '',
          msgSendBack: `Wrong parameters. ${generalExample}`,
          errorField: 'source',
          notifyType: 'log',
        };
      }

      let rangeOrValue; let coin;
      let exchange; let exchangeName; let pair;
      let pairObj;
      let percentString; let percentValue;

      let pwLowPrice; let pwHighPrice; let pwMidPrice; let pwDeviationPercent; let pwSource; let pwSourcePolicy; let pwAction;

      if (params[1].indexOf('@') > -1) {
        // Watch pair@exchange

        const pairExchangeExample = 'Example: */enable pw ADM/USDT@Azbit 0.5% smart prevent*.';

        [pair, exchange] = params[1].split('@');

        if (!pair || pair.length < 3 || pair.indexOf('/') === -1 || !exchange || exchange.length < 3) {
          return {
            msgNotify: '',
            isError: true,
            errorField: 'source',
            msgSendBack: isWebApi ? `Trading pair ${pair.toUpperCase()} is not valid` : `Wrong price source. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }

        config.exchanges.forEach((e) => {
          if (e.toLowerCase() === exchange.toLowerCase()) {
            exchangeName = e;
          }
        });

        if (!exchangeName) {
          return {
            msgNotify: '',
            isError: true,
            errorField: 'source',
            msgSendBack: isWebApi ? `Unknown exchange: ${exchange}` : `I don't support ${exchange} exchange. Supported exchanges: ${config.supported_exchanges}. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }

        // Parse 'pair' string to market pair object, { pair, coin1, coin2 }
        // In case of external exchange, start loading getMarkets(). Do not connect to socket at this stage.
        pairObj = orderUtils.parseMarket(pair, exchangeName, true);
        if (!pairObj) {
          return {
            msgNotify: '',
            isError: true,
            errorField: 'source',
            msgSendBack: isWebApi ? `Trading pair ${pair.toUpperCase()} is not valid` : `Trading pair ${pair.toUpperCase()} is not valid. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }

        if (pairObj.coin1 !== config.coin1) {
          return {
            msgNotify: '',
            isError: true,
            errorField: 'source',
            msgSendBack: isWebApi ? `Base currency of a trading pair must be ${config.coin1}` : `Base currency of a trading pair must be ${config.coin1}, like ${config.coin1}/USDT.`,
            notifyType: 'log',
          };
        }

        if (
          pairObj.pair.toUpperCase() === config.pair.toUpperCase() &&
          exchange.toLowerCase() === config.exchange.toLowerCase()
        ) {
          return {
            msgNotify: '',
            isError: true,
            errorField: 'source',
            msgSendBack: isWebApi ? `Unable to set Price watcher to the same trading pair as I trade, ${pairObj.pair}@${exchangeName}` : `Unable to set Price watcher to the same trading pair as I trade, ${pairObj.pair}@${exchangeName}. Set price in numbers or watch other trading pair/exchange. ${generalExample}`,
            notifyType: 'log',
          };
        }

        // Test if we can retrieve order book for the specific pair on the exchange
        let orderBook;
        if (exchange.toLowerCase() === config.exchange) {
          orderBook = await orderUtils.getOrderBookCached(pairObj.pair, utils.getModuleName(module.id));
        } else {
          if (!pairObj.exchangeApi.markets) {
            // We already created pairObj.exchangeApi when orderUtils.parseMarket(), but markets are probably still loading
            const pauseMs = 4000;
            await utils.pauseAsync(pauseMs, `${pauseMs} msec pause to ensure the ${exchangeName} loaded markets…`);
          }

          orderBook = await pairObj.exchangeApi.getOrderBook(pairObj.pair);
        }

        if (!orderBook || !orderBook.asks[0] || !orderBook.bids[0]) {
          const noOrderBookInfo = `Unable to receive an order book for ${pairObj.pair} at ${exchangeName} exchange.`;
          log.warn(noOrderBookInfo);

          return {
            msgNotify: '',
            isError: true,
            errorField: 'source',
            msgSendBack: isWebApi ? noOrderBookInfo : `${noOrderBookInfo} Check if you've specified the trading pair correctly; Or it may be a temporary API error.`,
            notifyType: 'log',
          };
        }

        pwSource = `${pairObj.pair}@${exchangeName}`;

        // Validate deviation percent
        percentString = params[2];
        if (!percentString || (percentString.slice(-1) !== '%')) {
          return {
            msgNotify: '',
            msgSendBack: `Set a deviation in percentage. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }
        percentValue = +percentString.slice(0, -1);
        if (percentValue === Infinity || percentValue < 0 || percentValue > 90) {
          return {
            msgNotify: '',
            msgSendBack: `Set correct deviation in percentage. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }
        pwDeviationPercent = percentValue;

        // Validate deviation percent policy
        pwSourcePolicy = params[3];
        pwSourcePolicy = pwSourcePolicy?.toLowerCase();
        if (!['smart', 'strict'].includes(pwSourcePolicy)) {
          return {
            msgNotify: '',
            msgSendBack: `Wrong deviation policy. Allowed _smart_ or _strict_. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }

        // Validate action
        pwAction = params[4];
        pwAction = pwAction?.toLowerCase();
        if (!['fill', 'prevent'].includes(pwAction)) {
          return {
            msgNotify: '',
            msgSendBack: `Wrong Pw action. Allowed _fill_ or _prevent_. ${pairExchangeExample}`,
            notifyType: 'log',
          };
        }

        pwLowPrice = 0;
        pwHighPrice = 0;
        pwMidPrice = 0;

        infoString = ` based on _${pwSource}_ with _${pwSourcePolicy}_ policy, _${pwDeviationPercent.toFixed(2)}%_ deviation and _${pwAction}_ action`;

      } else {
        // Watch price in coin
        const rangeOrValueExample = 'Example: */enable pw 0.1—0.2 USDT fill* or */enable pw 0.5 USDT 1% fill*.';
        const valueExample = 'Example: */enable pw 0.5 USDT 1% fill*.';

        rangeOrValue = utils.parseRangeOrValue(params[1]);
        if (!rangeOrValue.isRange && !rangeOrValue.isValue) {
          return {
            msgNotify: '',
            msgSendBack: isWebApi ? 'Set correct source' : `Set a price range or value. ${rangeOrValueExample}`,
            notifyType: 'log',
            isError: true,
            errorField: 'source',
          };
        }

        coin = params[2];
        if (!coin || !coin.length || coin.toUpperCase() === config.coin1) {
          return {
            msgNotify: '',
            msgSendBack: isWebApi ? 'Incorrect currency' : `Incorrect currency. ${rangeOrValueExample}`,
            notifyType: 'log',
            errorField: 'currency',
            isError: true,
          };
        }
        coin = coin.toUpperCase();

        if (!exchangerUtils.hasTicker(coin)) {
          return {
            msgNotify: '',
            msgSendBack: isWebApi ? 'Incorrect currency' : `I don't know currency ${coin}. ${rangeOrValueExample}`,
            notifyType: 'log',
            errorField: 'currency',
            isError: true,
          };
        }

        let pwActionParam;

        if (rangeOrValue.isRange) {
          pwLowPrice = rangeOrValue.from;
          pwHighPrice = rangeOrValue.to;
          pwMidPrice = (pwLowPrice + pwHighPrice) / 2;
          pwDeviationPercent = (pwHighPrice - pwLowPrice) / 2 / pwMidPrice * 100;
          pwSource = coin;
          pwActionParam = params[3];
        }

        if (rangeOrValue.isValue) {
          percentString = params[3];

          if (!percentString || (percentString.slice(-1) !== '%')) {
            return {
              msgNotify: '',
              msgSendBack: `Set a deviation in percentage. ${valueExample}`,
              notifyType: 'log',
            };
          }

          percentValue = +percentString.slice(0, -1);
          if (!percentValue || percentValue === Infinity || percentValue <= 0 || percentValue > 90) {
            return {
              msgNotify: '',
              msgSendBack: `Set correct deviation in percentage. ${valueExample}`,
              notifyType: 'log',
            };
          }

          pwLowPrice = rangeOrValue.value * (1 - percentValue/100);
          pwHighPrice = rangeOrValue.value * (1 + percentValue/100);
          pwMidPrice = rangeOrValue.value;
          pwDeviationPercent = percentValue;
          pwSource = coin;
          pwActionParam = params[4];
        }

        let convertedString;
        let sourceString;
        let pwLowPriceInCoin2;
        let marketDecimals;

        if (coin === config.coin2) {
          pwLowPriceInCoin2 = pwLowPrice;
          sourceString = `${coin}`;
          convertedString = '';
          marketDecimals = coin2Decimals;
        } else {
          pwLowPriceInCoin2 = exchangerUtils.convertCryptos(coin, config.coin2, pwLowPrice).outAmount;
          sourceString = `${coin} (global rate)`;
          convertedString = ` (${pwLowPrice} converted to ${config.coin2})`;
          marketDecimals = 8;
        }

        if (!utils.isPositiveNumber(pwLowPriceInCoin2)) {
          return {
            msgNotify: '',
            msgSendBack: `Unable to convert ${coin} to ${config.coin2}. ${rangeOrValueExample}`,
            notifyType: 'log',
          };
        }

        // Validate action
        pwAction = pwActionParam?.toLowerCase();
        if (!['fill', 'prevent'].includes(pwAction)) {
          return {
            msgNotify: '',
            msgSendBack: `Wrong Pw action. Allowed _fill_ or _prevent_. ${rangeOrValueExample}`,
            notifyType: 'log',
          };
        }

        if (tradeParams.mm_priceSupportLowPrice > pwLowPriceInCoin2) {
          return {
            msgNotify: '',
            msgSendBack: `Support price ${tradeParams.mm_priceSupportLowPrice.toFixed(coin2Decimals)} ${config.coin2} is greater, than Price watcher's lower bound of ${pwLowPriceInCoin2.toFixed(coin2Decimals)} ${coin}${convertedString}. Update support price with */enable sp* command, or set suitable Price watcher's range.`,
            notifyType: 'log',
          };
        }

        infoString = ` from ${pwLowPrice.toFixed(marketDecimals)} to ${pwHighPrice.toFixed(marketDecimals)} ${sourceString}—${pwDeviationPercent.toFixed(2)}% price deviation and _${pwAction}_ action`;
      }

      optionsString = 'Price watching';

      let isConfirmed = params[params.length-1];
      if (['-y', '-Y'].includes(isConfirmed)) {
        isConfirmed = true;
      } else {
        isConfirmed = false;
      }

      if (isConfirmed) {
        const pw = require('../trade/mm_price_watcher');
        pw.setIsPriceActual(false, '/enable pw');

        tradeParams.mm_isPriceWatcherActive = true;
        tradeParams.mm_priceWatcherLowPriceInSourceCoin = pwLowPrice;
        tradeParams.mm_priceWatcherMidPriceInSourceCoin = pwMidPrice;
        tradeParams.mm_priceWatcherHighPriceInSourceCoin = pwHighPrice;
        tradeParams.mm_priceWatcherDeviationPercent = pwDeviationPercent;
        tradeParams.mm_priceWatcherSource = pwSource;
        tradeParams.mm_priceWatcherSourcePolicy = pwSourcePolicy;
        tradeParams.mm_priceWatcherAction = pwAction;

        pw.savePw('User> Price watcher enabled with /enable pw');
      } else {
        let priceInfoString = '';
        pairObj = orderUtils.parseMarket(config.pair);

        const currencies = exchangerUtils.currencies;
        const res = Object
            .keys(currencies)
            .filter((t) => t.startsWith(pairObj.coin1 + '/'))
            .map((t) => {
              const p = `${pairObj.coin1}/**${t.replace(pairObj.coin1 + '/', '')}**`;
              return `${p}: ${currencies[t]}`;
            })
            .join(', ');

        if (!res.length) {
          if (!pairObj.pair) {
            priceInfoString = `I can’t get rates for *${pairObj.coin1}* from Infoservice.`;
          }
        } else {
          priceInfoString = `Global market rates for ${pairObj.coin1}:\n${res}.`;
        }

        if (priceInfoString) {
          priceInfoString += '\n\n';
        }

        const exchangeRatesInfo = await getRatesInfo(pairObj.pair);
        priceInfoString += exchangeRatesInfo.ratesString;

        setPendingConfirmation(`/enable ${params.join(' ')}`);

        msgNotify = '';
        msgSendBack = `Are you sure to enable ${optionsString} for ${config.pair} pair ${infoString}? Confirm with **/y** command or ignore.\n\n${priceInfoString}`;

        return {
          msgNotify,
          msgSendBack,
          notifyType: 'log',
        };
      }

    } // type === "pw"

    msgNotify = `${config.notifyName} enabled ${optionsString} for ${config.pair} pair${infoString}.`;
    msgSendBack = `${optionsString} is enabled for ${config.pair} pair${infoString}.${infoStringSendBack}`;
    if (!tradeParams.mm_isActive) {
      msgNotify += ` Market making and ${optionsString} are not started yet.`;
      msgSendBack += ` To start Market making and ${optionsString}, type */start mm*.`;
    }
  } catch (e) {
    log.error(`Error in enable() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

function disable(params) {
  let msgNotify; let msgSendBack; let optionsString;

  const type = params[0]?.toLowerCase();
  const typeValidation = validateFeature(type, 'disable');
  if (!typeValidation.validated) {
    return {
      msgNotify: '',
      msgSendBack: typeValidation.msgSendBack,
      notifyType: 'log',
    };
  }

  if (type === 'ob') {
    tradeParams.mm_isOrderBookActive = false;
    optionsString = 'Order book building';
  } else if (type === 'liq') {
    tradeParams.mm_isLiquidityActive = false;
    optionsString = 'Liquidity and spread maintenance';
  } else if (type === 'pw') {
    tradeParams.mm_isPriceWatcherActive = false;
    const pw = require('../trade/mm_price_watcher');
    pw.savePw('User /disable pw command');
    optionsString = 'Price watching';
  }

  msgNotify = `${config.notifyName} disabled ${optionsString} for ${config.pair} pair on ${config.exchangeName}.`;
  msgSendBack = `${optionsString} is disabled for ${config.pair} pair on ${config.exchangeName}.`;
  if (tradeParams.mm_isActive) {
    msgNotify += ' Market making is still active.';
    msgSendBack += ' Market making is still active—to stop it, type */stop mm*.';
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

function buypercent(param) {
  const val = +((param[0] || '').trim());
  if (!val || val === Infinity || val < 0 || val > 100) {
    return {
      msgNotify: '',
      msgSendBack: 'Invalid percentage of buy orders. Example: */buyPercent 85*.',
      notifyType: 'log',
    };
  }

  tradeParams.mm_buyPercent = val / 100;
  return {
    msgNotify: `${config.notifyName} is set to make market with ${val}% of buy orders for ${config.pair} pair. Order book building is set to ${100-val}% of buy orders.`,
    msgSendBack: `Set to make market with ${val}% of buy orders for ${config.pair} pair. Order book building is set to ${100-val}% of buy orders.`,
    notifyType: 'log',
  };
}

function amount(param) {
  const val = (param[0] || '').trim();
  if (!val || !val.length || (val.indexOf('-') === -1)) {
    return {
      msgNotify: '',
      msgSendBack: `Invalid values for market making of ${config.pair}. Example: */amount 0.01-20*.`,
      notifyType: 'log',
    };
  }
  const [minStr, maxStr] = val.split('-');
  const min = +minStr;
  const max = +maxStr;
  if (!min || min === Infinity || !max || max === Infinity) {
    return {
      msgNotify: '',
      msgSendBack: `Invalid values for market making of ${config.pair}. Example: */amount 0.01-20*.`,
      notifyType: 'log',
    };
  }
  if (min > max) {
    return {
      msgNotify: '',
      msgSendBack: `Invalid values for market making of ${config.pair}. Value _to_ must be greater or equal, than _from_. Example: */amount 0.01-20*.`,
      notifyType: 'log',
    };
  }

  const oldVolume = exchangerUtils.estimateCurrentDailyTradeVolume();
  tradeParams.mm_minAmount = min;
  tradeParams.mm_maxAmount = max;
  const newVolume = exchangerUtils.estimateCurrentDailyTradeVolume();

  const volumeChangePercent = utils.numbersDifferencePercentDirect(oldVolume.coin1, newVolume.coin1);
  const operator = oldVolume.coin1 > newVolume.coin1 ? '–' : '+';
  const volumeChangePercentString = `${operator}${volumeChangePercent.toFixed(2)}%`;

  const infoString = `to make market amounts from ${min} to ${max} ${config.coin1} for ${config.pair} pair. Estimate mm trade volume changed ${volumeChangePercentString}: ${exchangerUtils.getVolumeChangeInfoString(oldVolume, newVolume)}.`;

  return {
    msgNotify: `${config.notifyName} is set ${infoString}`,
    msgSendBack: `Set ${infoString}`,
    notifyType: 'log',
  };
}

function interval(param) {
  const val = (param[0] || '').trim();
  if (!val || !val.length || (val.indexOf('-') === -1)) {
    return {
      msgNotify: '',
      msgSendBack: `Invalid intervals for market making of ${config.pair}. Example: */interval 1-5 min*.`,
      notifyType: 'log',
    };
  }

  const time = (param[1] || '').trim().toLowerCase();
  let multiplier;

  switch (time) {
    case 'sec':
      multiplier = 1000;
      break;
    case 'min':
      multiplier = 1000*60;
      break;
    case 'hour':
      multiplier = 1000*60*60;
      break;
    default:
      break;
  }

  if (!multiplier) {
    return {
      msgNotify: '',
      msgSendBack: 'Invalid time unit for interval. Set _sec_, _min_, or _hour_. Example: */interval 1-5 min*.',
      notifyType: 'log',
    };
  }

  const [minStr, maxStr] = val.split('-');
  const min = +minStr;
  const max = +maxStr;
  if (!min || min === Infinity || !max || max === Infinity) {
    return {
      msgNotify: '',
      msgSendBack: `Invalid intervals for market making of ${config.pair}. Example: */interval 1-5 min*.`,
      notifyType: 'log',
    };
  }
  if (min > max) {
    return {
      msgNotify: '',
      msgSendBack: `Invalid intervals for market making of ${config.pair}. Value _to_ must be greater or equal, than _from_. Example: */interval 1-5 min*.`,
      notifyType: 'log',
    };
  }

  const oldVolume = exchangerUtils.estimateCurrentDailyTradeVolume();
  tradeParams.mm_minInterval = Math.round(min * multiplier);
  tradeParams.mm_maxInterval = Math.round(max * multiplier);
  const newVolume = exchangerUtils.estimateCurrentDailyTradeVolume();

  const volumeChangePercent = utils.numbersDifferencePercentDirect(oldVolume.coin1, newVolume.coin1);
  const operator = oldVolume.coin1 > newVolume.coin1 ? '–' : '+';
  const volumeChangePercentString = `${operator}${volumeChangePercent.toFixed(2)}%`;

  const infoString = `to make market in intervals from ${min} to ${max} ${time} for ${config.pair} pair. Estimate mm trade volume changed ${volumeChangePercentString}: ${exchangerUtils.getVolumeChangeInfoString(oldVolume, newVolume)}.`;

  return {
    msgNotify: `${config.notifyName} is set ${infoString}`,
    msgSendBack: `Set ${infoString}`,
    notifyType: 'log',
  };
}

async function clear(params) {
  try {
    let pair = params[0];
    if (!pair || pair.indexOf('/') === -1) {
      pair = config.pair;
    }
    const pairObj = orderUtils.parseMarket(pair);

    let doForce;
    let purposes;
    let purposeString;
    let type;
    let filter;
    let filerPriceString;

    const orderPurposes = utils.cloneObject(orderCollector.orderPurposes);
    delete orderPurposes['all'];

    for (const param of params) {
      if (['buy'].includes(param.toLowerCase())) {
        type = 'buy';
      }
      if (['sell'].includes(param.toLowerCase())) {
        type = 'sell';
      }
      if (['force'].includes(param.toLowerCase())) {
        doForce = true;
      }

      if (['all'].includes(param.toLowerCase())) {
        purposes = 'all';
      }
      if (['unk'].includes(param.toLowerCase())) {
        purposes = 'unk';
        purposeString = 'unknown';
      }

      Object.keys(orderPurposes).forEach((purpose) => {
        if (param.toLowerCase() === purpose) {
          purposes = [purpose];
          purposeString = orderPurposes[purpose]?.toLowerCase();
        }
      });

      if (param.startsWith('>') || param.startsWith('<')) {
        if (['all', 'unk'].includes(purposes)) {
          return {
            msgNotify: '',
            msgSendBack: `Price filter doesn't work with **all** and **unk** orders. Try: */clear mm sell >0.5 ${config.coin2}*.`,
            notifyType: 'log',
          };
        }
        filerPriceString = param;
        let price = param;
        const paramIndex = params.indexOf(param);
        const operator = param.charAt(0);
        price = +price.substring(1);
        if (!utils.isPositiveOrZeroNumber(price)) {
          return {
            msgNotify: '',
            msgSendBack: `Indicate price after '${operator}'. Example: */clear mm sell >0.5 ${config.coin2}*.`,
            notifyType: 'log',
          };
        }
        const priceCoin = params[paramIndex + 1]?.toUpperCase();
        if (priceCoin !== pairObj.coin2) {
          return {
            msgNotify: '',
            msgSendBack: `Price should be in ${pairObj.coin2} for ${pairObj.pair}. Example: */clear ${pairObj.pair} mm sell >0.5 ${pairObj.coin2}*.`,
            notifyType: 'log',
          };
        }
        filter = { };
        if (operator === '<') {
          filter.price = { $lt: price };
        } else {
          filter.price = { $gt: price };
        }
      }
    }

    if (!purposes) {
      return {
        msgNotify: '',
        msgSendBack: 'Specify type of orders to clear. F. e., */clear mm sell*.',
        notifyType: 'log',
      };
    }

    let output = '';
    let clearedInfo = {};
    const typeString = type ? `**${type}**-` : '';

    const api = traderapi;

    if (purposes === 'all') {
      clearedInfo = await orderCollector.clearAllOrders(pairObj.pair, doForce, type, 'User command', `${typeString}orders`, api);
    } else { // Closing orders of specified type only
      let filterString = '';
      if (purposes === 'unk') {
        clearedInfo = await orderCollector.clearUnknownOrders(pairObj.pair, doForce, type, 'User command', `**${purposeString}** ${typeString}orders${filterString}`, api);
      } else {
        if (filter) filterString = ` with price ${filerPriceString} ${config.coin2}`;
        clearedInfo = await orderCollector.clearLocalOrders(purposes, pairObj.pair, doForce, type, filter, 'User command', `**${purposeString}** ${typeString}orders${filterString}`, api);
      }
    }
    output = clearedInfo.logMessage;

    return {
      msgNotify: '',
      msgSendBack: output,
      notifyType: 'log',
    };
  } catch (e) {
    log.error(`Error in clear() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

async function fill(params) {
  const isConfirmed = params.find((param) => ['-y'].includes(param.toLowerCase())) !== undefined;

  let count; let amount; let low; let high; let amountName;
  params.forEach((param) => {
    try {
      if (param.startsWith('count')) {
        count = +param.split('=')[1].trim();
      }
      if (param.startsWith('amount')) {
        amount = +param.split('=')[1].trim();
        amountName = 'amount';
      }
      if (param.startsWith('quote')) {
        amount = +param.split('=')[1].trim();
        amountName = 'quote';
      }
      if (param.startsWith('low')) {
        low = +param.split('=')[1].trim();
      }
      if (param.startsWith('high')) {
        high = +param.split('=')[1].trim();
      }
    } catch (e) {
      return {
        msgNotify: '',
        msgSendBack: 'Wrong arguments. It works like this: */fill ADM/BTC buy quote=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
        notifyType: 'log',
      };
    }
  });

  if (params.length < 4) {
    return {
      msgNotify: '',
      msgSendBack: 'Wrong arguments. It works like this: */fill ADM/BTC buy quote=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
      notifyType: 'log',
    };
  }

  let output = '';
  let type;

  let pair = params[0];
  if (!pair || pair.indexOf('/') === -1) {
    pair = config.pair;
    type = params[0]?.trim().toLowerCase();
  } else {
    type = params[1]?.trim().toLowerCase();
  }

  if (!['buy', 'sell'].includes(type)) {
    return {
      msgNotify: '',
      msgSendBack: 'Specify _buy_ or _sell_ orders to fill. Example: */fill ADM/BTC buy quote=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
      notifyType: 'log',
    };
  }

  const pairObj = orderUtils.parseMarket(pair);

  if (!amount || !amountName || (type === 'buy' && amountName === 'amount') || (type === 'sell' && amountName === 'quote')) {
    output = 'Buy should follow with _quote_, sell with _amount_.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (!count || count === Infinity || count < 1 || count === undefined) {
    output = 'Specify order count.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (!high || high === Infinity || high === undefined || !low || low === Infinity || low === undefined) {
    output = 'Specify _low_ and _high_ prices to fill orders.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (low > high) {
    output = 'To fill orders _high_ should be greater than _low_.';
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  const api = traderapi;

  const onWhichAccount = '';

  const balances = await orderUtils.getBalancesCached(false, utils.getModuleName(module.id), undefined, undefined, api);
  let balance;
  let isBalanceEnough = true;
  if (balances) {
    try {
      if (type === 'buy') {
        balance = balances.filter((crypto) => crypto.code === pairObj.coin2)?.[0]?.free || 0;
        output = `Not enough ${pairObj.coin2}${onWhichAccount} to fill orders. Check balances.`;
      } else {
        balance = balances.filter((crypto) => crypto.code === pairObj.coin1)?.[0]?.free || 0;
        output = `Not enough ${pairObj.coin1}${onWhichAccount} to fill orders. Check balances.`;
      }
      isBalanceEnough = balance >= amount;
    } catch (e) {
      output = `Unable to process balances${onWhichAccount}: ${e}. Check parameters.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
  } else {
    output = `Unable to get ${config.exchangeName} balances${onWhichAccount}. Try again.`;
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (!isBalanceEnough) {
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  let totalUSD;

  if (amountName === 'quote') {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin2, 'USD', amount).outAmount;
  } else {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin1, 'USD', amount).outAmount;
  }

  if (config.amount_to_confirm_usd && totalUSD && totalUSD >= config.amount_to_confirm_usd && !isConfirmed) {
    setPendingConfirmation(`/fill ${params.join(' ')}`);

    const totalUSDstring = utils.formatNumber(totalUSD.toFixed(0), true);

    let confirmationMessage;
    if (amountName === 'quote') {
      confirmationMessage = `Are you sure to fill ${count} orders${onWhichAccount} to ${type} ${pairObj.coin1} worth ~${totalUSDstring} USD priced from ${low} to ${high} ${pairObj.coin2}?`;
    } else {
      confirmationMessage = `Are you sure to fill ${count} orders${onWhichAccount} to ${type} ${amount} ${pairObj.coin1} (worth ~${totalUSDstring} USD) priced from ${low} to ${high} ${pairObj.coin2}?`;
    }
    confirmationMessage += ' Confirm with **/y** command or ignore.';

    return {
      msgNotify: '',
      msgSendBack: confirmationMessage,
      notifyType: 'log',
    };
  }

  // Make order list
  const orderList = [];
  const delta = high - low;
  const step = delta / count;
  const orderAmount = amount / count;
  const deviation = 0.9;

  let price = low;
  let total = 0; let coin1Amount = 0; let coin2Amount = 0;
  for (let i=0; i < count; i++) {
    price += utils.randomDeviation(step, deviation);
    coin1Amount = utils.randomDeviation(orderAmount, deviation);
    total += coin1Amount;

    // Checks if total or price exceeded
    if (total > amount) {
      if (count === 1) {
        coin1Amount = amount;
      } else {
        break;
      }
    }
    if (price > high) {
      if (count === 1) {
        price = high;
      } else {
        break;
      }
    }

    // Count base and quote currency amounts
    if (type === 'buy') {
      coin2Amount = coin1Amount;
      coin1Amount = coin1Amount / price;
    } else {
      // coin1Amount = coin1Amount;
      coin2Amount = coin1Amount * price;
    }
    orderList.push({
      price,
      amount: coin1Amount,
      altAmount: coin2Amount,
    });
  }

  // Place orders
  let total1 = 0; let total2 = 0;
  let placedOrders = 0; let notPlacedOrders = 0;
  let order;
  for (let i = 0; i < orderList.length; i++) {
    order = await orderUtils.addGeneralOrder(type, pairObj.pair, orderList[i].price, orderList[i].amount, 1, null, pairObj, 'man', api);
    if (order?._id) {
      placedOrders += 1;
      total1 += +orderList[i].amount;
      total2 += +orderList[i].altAmount;
    } else {
      notPlacedOrders += 1;
    }
  }

  let notPlacedString = '';
  if (placedOrders > 0) {
    if (notPlacedOrders) {
      notPlacedString = ` ${notPlacedOrders} orders missed because of errors, check log file for details.`;
    }
    output = `${placedOrders} orders${onWhichAccount} to ${type} ${utils.formatNumber(+total1.toFixed(pairObj.coin1Decimals), false)} ${pairObj.coin1} for ${utils.formatNumber(+total2.toFixed(pairObj.coin2Decimals), false)} ${pairObj.coin2}.${notPlacedString}`;
  } else {
    output = `No orders${onWhichAccount} were placed. Check log file for details.`;
  }

  const msgNotify = placedOrders > 0 ? `${config.notifyName} placed ${output}` : '';
  const msgSendBack = placedOrders > 0 ? `Placed ${output}` : output;

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

async function buy(params) {
  const result = getBuySellParams(params, 'buy');
  return await buy_sell(result, 'buy');
}

async function sell(params) {
  const result = getBuySellParams(params, 'sell');
  return await buy_sell(result, 'sell');
}

function getBuySellParams(params, type) {
  const isConfirmed = params.find((param) => ['-y'].includes(param.toLowerCase())) !== undefined;

  // default: pair={config} BaseCurrency/QuoteCurrency, price=market
  // amount XOR quote
  // buy ADM/BTC amount=200 price=0.00000224 — buy 200 ADM at 0.00000224
  // sell ADM/BTC amount=200 price=0.00000224 — sell 200 ADM at 0.00000224
  // buy ADM/BTC quote=0.01 price=0.00000224 — buy ADM for 0.01 BTC at 0.00000224
  // sell ADM/BTC quote=0.01 price=0.00000224 — sell ADM to get 0.01 BTC at 0.00000224

  // when Market order, buy should follow quote, sell — amount
  // buy ADM/BTC quote=0.01 — buy ADM for 0.01 BTC at market price
  // buy ADM/BTC quote=0.01 price=market — the same
  // buy ADM/BTC quote=0.01 — buy ADM for 0.01 BTC at market price
  // sell ADM/BTC amount=8 — sell 8 ADM at market price

  let amount; let quote; let price = 'market';
  params.forEach((param) => {
    try {
      if (param.startsWith('quote')) {
        quote = +param.split('=')[1].trim();
      }
      if (param.startsWith('amount')) {
        amount = +param.split('=')[1].trim();
      }
      if (param.startsWith('price')) {
        price = param.split('=')[1].trim();
        if (price.toLowerCase() === 'market') {
          price = 'market';
        } else {
          price = +price;
        }
      }
    } catch (e) {
      return {
        msgNotify: '',
        msgSendBack: 'Wrong arguments. Command works like this: */sell ADM/BTC amount=200 price=market*.',
        notifyType: 'log',
      };
    }
  });

  if (params.length < 1) {
    return {
      msgNotify: '',
      msgSendBack: 'Wrong arguments. Command works like this: */sell ADM/BTC amount=200 price=market*.',
      notifyType: 'log',
    };
  }

  if ((quote && amount) || (!quote && !amount)) {
    return {
      msgNotify: '',
      msgSendBack: 'You should specify amount _or_ quote, and not both of them.',
      notifyType: 'log',
    };
  }

  const amountOrQuote = quote || amount;

  let output = '';
  if (((!price || price === Infinity || price <= 0) && (price !== 'market')) || (!amountOrQuote || amountOrQuote === Infinity || amountOrQuote <= 0)) {
    output = `Incorrect params: ${amountOrQuote}, ${price}. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
    return {
      msgNotify: '',
      msgSendBack: `${output}`,
      notifyType: 'log',
    };
  }

  if (price === 'market' && !traderapi.features().placeMarketOrder) {
    return {
      msgNotify: '',
      msgSendBack: `Placing Market orders on ${config.exchangeName} via API is not supported.`,
      notifyType: 'log',
    };
  }

  // When Market order, buy should pass quote parameter, when sell — amount
  if (price === 'market' && !traderapi.features()?.allowAmountForMarketBuy) {
    if ((type === 'buy' && !quote) || ((type === 'sell' && !amount))) {
      output = 'When placing Market order, buy should follow with _quote_, sell with _amount_. Command works like this: */sell ADM/BTC amount=200 price=market*.';
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
  }

  // When Market order, amount in coin1 is necessary for both buy and sell
  if (price === 'market' && traderapi.features()?.amountForMarketOrderNecessary) {
    if (!amount) {
      output = `When placing Market order on ${config.exchangeName}, _amount_ is necessary. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
  }

  const api = traderapi;

  let pair = params[0];
  if (!pair || pair.indexOf('/') === -1) {
    pair = config.pair;
  }
  const pairObj = orderUtils.parseMarket(pair);

  let totalUSD;

  if (amount) {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin1, 'USD', amount).outAmount;
  } else {
    totalUSD = exchangerUtils.convertCryptos(pairObj.coin2, 'USD', quote).outAmount;
  }

  if (config.amount_to_confirm_usd && totalUSD && totalUSD >= config.amount_to_confirm_usd && !isConfirmed) {
    setPendingConfirmation(`/${type} ${params.join(' ')}`);

    let msgSendBack = '';

    const totalUSDstring = utils.formatNumber(totalUSD.toFixed(0), true);
    const amountCalculated = amount ||
      exchangerUtils.convertCryptos(pairObj.coin2, pairObj.coin1, quote).outAmount.toFixed(pairObj.coin1Decimals);

    if (price === 'market') {
      if (amount) {
        msgSendBack += `Are you sure to ${type} ${amountCalculated} ${pairObj.coin1} (worth ~${totalUSDstring} USD) at market price?`;
      } else {
        msgSendBack += `Are you sure to ${type} ${pairObj.coin1} worth ~${totalUSDstring} USD at market price?`;
      }
    } else {
      msgSendBack += `Are you sure to ${type} ${amountCalculated} ${pairObj.coin1} (worth ~${totalUSDstring} USD) at ${price} ${pairObj.coin2}?`;

      const marketPrice = exchangerUtils.convertCryptos(pairObj.coin1, pairObj.coin2, 1).outAmount;
      const priceDifference = utils.numbersDifferencePercentDirectNegative(marketPrice, price);

      if (
        (priceDifference < -30 && type === 'buy') ||
        (priceDifference > 30 && type === 'sell')
      ) {
        msgSendBack += ` **Warning: ${type} price is ${Math.abs(priceDifference).toFixed(0)}% ${marketPrice > price ? 'less' : 'greater'} than market**.`;
      }
    }
    msgSendBack += ' Confirm with **/y** command or ignore.';

    return {
      msgSendBack,
      msgNotify: '',
      notifyType: 'log',
    };
  }

  return {
    amount,
    price,
    quote,
    pairObj,
    api,
  };
}

async function buy_sell(params, type) {
  if (params.msgSendBack) {
    return params; // Error info here
  }

  if (!params.amount) {
    params.amount = params.quote / params.price;
  } else {
    params.quote = params.amount * params.price;
  }

  let msgNotify; let msgSendBack;
  const isMarketOrder = params.price === 'market';

  const result = await orderUtils.addGeneralOrder(
      type,
      params.pairObj.pair,
      isMarketOrder ? null : params.price,
      params.amount,
      isMarketOrder ? 0 : 1,
      params.quote,
      params.pairObj,
      'man',
      params.api,
  );

  if (result !== undefined) {
    msgSendBack = result.message;

    if (result?._id) {
      msgNotify = `${config.notifyName}: ${result.message}`;
    }
  } else {
    const onWhichAccount = params.api?.isSecondAccount ? ' (on second account)' : '';
    const paramsInfo = `type=${type}, amount=${params.amount}, quote=${params.quote}, price=${params.price}, pair=${JSON.stringify(params.pairObj.pair)}`;

    msgSendBack = `Request to place an order${onWhichAccount} with params [${paramsInfo}] failed. It looks like an API temporary error. Try again.`;
    msgNotify = '';

    log.error(`Error in buy_sell() of ${utils.getModuleName(module.id)} module: ${msgSendBack}`);
  }

  return {
    msgNotify,
    msgSendBack,
    notifyType: 'log',
  };
}

function params() {
  let output = `I am set to work with ${config.pair} pair on ${config.exchangeName}. Current trading settings:`;
  output += '\n\n' + JSON.stringify(tradeParams, null, 3);

  return {
    msgNotify: '',
    msgSendBack: `${output}`,
    notifyType: 'log',
  };
}

function help({}, {}, commandFix) {
  const twoKeysInfo = '';
  let output = `I am **online** and ready to trade.${twoKeysInfo} I do trading and market-making, and provide market info and stats.`;
  output += ' See command reference on https://marketmaking.app/commands/';
  output += '\nHappy trading!';

  if (commandFix === 'help') {
    output += '\n\nNote: commands starts with slash **/**. Example: **/help**.';
  }

  return {
    msgNotify: '',
    msgSendBack: `${output}`,
    notifyType: 'log',
  };
}

async function rates(params) {
  let output = '';

  try {
    // if no coin/pair is set, treat it as coin1 set in config
    if (!params[0]) {
      params[0] = config.coin1;
    }

    // if coin1 only, treat it as pair set in config
    if (params[0]?.toUpperCase().trim() === config.coin1) {
      params[0] = config.pair;
    }

    let pair; let coin1;
    const pairObj = orderUtils.parseMarket(params[0]);
    if (pairObj) {
      pair = pairObj.pair;
      coin1 = pairObj.coin1;
    } else {
      coin1 = params[0]?.toUpperCase();
    }

    const res = Object
        .keys(exchangerUtils.currencies)
        .filter((t) => t.startsWith(coin1 + '/'))
        .map((t) => {
          const quoteCoin = t.replace(coin1 + '/', '');
          const pair = `${coin1}/**${quoteCoin}**`;
          const rate = utils.formatNumber(exchangerUtils.currencies[t].toFixed(constants.PRECISION_DECIMALS));
          return `${pair}: ${rate}`;
        })
        .join(', ');

    if (!res.length) {
      if (!pair) {
        output = `I can’t get rates for *${coin1} from Infoservice*. Try */rates ADM*.`;
        return {
          msgNotify: '',
          msgSendBack: output,
          notifyType: 'log',
        };
      }
    } else {
      output = `Global market rates for ${coin1}:\n${res}.`;
    }

    if (pair) {
      if (output) {
        output += '\n\n';
      }

      const exchangeRatesInfo = await getRatesInfo(pair);
      output += exchangeRatesInfo.ratesString;
    }
  } catch (e) {
    log.error(`Error in rates() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

async function getDepositInfo(accountNo = 0, tx = {}, coin1) {
  let output = '';

  try {
    const api = traderapi;
    const depositAddresses = await api.getDepositAddress(coin1);

    if (depositAddresses?.length) {
      output = `The deposit addresses for ${coin1} on ${config.exchangeName}:\n${depositAddresses.map(({ network, address, memo }) => `${network ? `_${network}_: ` : ''}${address}${memo ? `, ${memo}` : ''}`).join('\n')}`;
    } else {
      output = `Unable to get a deposit addresses for ${coin1}.`;

      if (depositAddresses?.message) {
        output += ` Error: ${depositAddresses?.message}.`;
      } else if (api.features().createDepositAddressWithWebsiteOnly) {
        output += ` Note: ${config.exchangeName} don't create new deposit addresses via API. Create it manually with a website.`;
      }
    }
  } catch (e) {
    log.error(`Error in getDepositInfo() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return output;
}

async function deposit(params, tx = {}) {
  let output = '';

  try {
    if (!params[0] || params[0].indexOf('/') !== -1) {
      output = 'Please specify coin to get a deposit address. F. e., */deposit ADM*.';
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }

    if (!traderapi.features().getDepositAddress) {
      return {
        msgNotify: '',
        msgSendBack: 'The exchange doesn\'t support receiving a deposit address.',
        notifyType: 'log',
      };
    }

    const coin1 = params[0].toUpperCase();
    const account0DepositInfo = await getDepositInfo(0, tx, coin1);
    const account1DepositInfo = undefined;
    output = account1DepositInfo ?
      account0DepositInfo.replace(`on ${config.exchangeName}`, `on ${config.exchangeName} (account 1)`) +
      '\n\n\n' + account1DepositInfo.replace(`on ${config.exchangeName}`, `on ${config.exchangeName} (account 2)`) :
      account0DepositInfo;
  } catch (e) {
    log.error(`Error in deposit() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

async function stats(params) {
  let output = '';

  try {
    let pair = params[0];
    if (!pair) {
      pair = config.pair;
    }
    if (pair.indexOf('/') === -1) {
      output = `Wrong pair '${pair}'. Try */stats ${config.pair}*.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
    const pairObj = orderUtils.parseMarket(pair);
    const coin1 = pairObj.coin1;
    const coin2 = pairObj.coin2;
    const coin1Decimals = pairObj.coin1Decimals;
    const coin2Decimals = pairObj.coin2Decimals;

    // First, get exchange 24h stats on pair: volume, low, high, spread
    const exchangeRates = await traderapi.getRates(pairObj.pair);
    const totalVolume24 = +exchangeRates?.volume;
    if (exchangeRates) {
      let volumeInCoin2String = '';
      if (exchangeRates.volumeInCoin2) {
        volumeInCoin2String = ` & ${utils.formatNumber(+exchangeRates.volumeInCoin2.toFixed(coin2Decimals), true)} ${coin2}`;
      }
      output += `${config.exchangeName} 24h stats for ${pairObj.pair} pair:`;
      let delta = exchangeRates.high-exchangeRates.low;
      let average = (exchangeRates.high+exchangeRates.low)/2;
      let deltaPercent = delta/average * 100;
      output += `\nVol: ${utils.formatNumber(+exchangeRates.volume.toFixed(coin1Decimals), true)} ${coin1}${volumeInCoin2String}.`;
      if (exchangeRates.low && exchangeRates.high) {
        output += `\nLow: ${exchangeRates.low.toFixed(coin2Decimals)}, high: ${exchangeRates.high.toFixed(coin2Decimals)}, delta: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      } else {
        output += '\nNo low and high rates available.';
      }
      delta = exchangeRates.ask-exchangeRates.bid;
      average = (exchangeRates.ask+exchangeRates.bid)/2;
      deltaPercent = delta/average * 100;
      output += `\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}, spread: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      if (exchangeRates.last) {
        output += `\nLast price: _${(exchangeRates.last).toFixed(coin2Decimals)}_ ${coin2}.`;
      }
    } else {
      output += `Unable to get ${config.exchangeName} stats for ${pairObj.pair}. Try again later.`;
    }

    // Second, get order book information
    const orderBook = await orderUtils.getOrderBookCached(pairObj.pair, utils.getModuleName(module.id));
    const orderBookInfo = utils.getOrderBookInfo(orderBook);
    if (orderBook && orderBookInfo) {
      const delta = orderBookInfo.smartAsk-orderBookInfo.smartBid;
      const average = (orderBookInfo.smartAsk+orderBookInfo.smartBid)/2;
      const deltaPercent = delta/average * 100;

      const bids2 = orderBookInfo.liquidity['percent2'].amountBidsQuote;
      const asks2 = orderBookInfo.liquidity['percent2'].amountAsks;
      const bidsFull = orderBookInfo.liquidity['full'].amountBidsQuote;
      const asksFull = orderBookInfo.liquidity['full'].amountAsks;

      const bidsPercent2 = bids2 / bidsFull * 100;
      const asksPercent2 = asks2 / asksFull * 100;

      const fairPrice2 = bids2 / asks2;
      const fairPriceFull = bidsFull / asksFull;

      output += '\n\n**Order book information**:\n\n';
      output += `Smart bid: ${orderBookInfo.smartBid.toFixed(coin2Decimals)}, smart ask: ${orderBookInfo.smartAsk.toFixed(coin2Decimals)}, smart spread: _${(delta).toFixed(coin2Decimals)}_ ${coin2} (${(deltaPercent).toFixed(2)}%).`;
      output += `\nFull depth (may be limited by exchange API): ${orderBookInfo.liquidity['full'].bidsCount} bids with ${utils.formatNumber(bidsFull.toFixed(coin2Decimals), true)} ${coin2}`;
      output += ` and ${orderBookInfo.liquidity['full'].asksCount} asks with ${utils.formatNumber(asksFull.toFixed(coin1Decimals), true)} ${coin1}.`;
      output += ` Fair price: _${utils.formatNumber(fairPriceFull.toFixed(coin2Decimals), true)}_ ${coin2}.`;
      output += `\nDepth ±2%: ${orderBookInfo.liquidity['percent2'].bidsCount} bids with ${utils.formatNumber(bids2.toFixed(coin2Decimals), true)} ${coin2} (${bidsPercent2.toFixed(2)}%)`;
      output += ` and ${orderBookInfo.liquidity['percent2'].asksCount} asks with ${utils.formatNumber(asks2.toFixed(coin1Decimals), true)} ${coin1} (${asksPercent2.toFixed(2)}%).`;
      if (fairPrice2) {
        output += ` Fair price: _${utils.formatNumber(fairPrice2.toFixed(coin2Decimals), true)}_ ${coin2}.`;
      }
    } else {
      output += `\n\nUnable to get ${config.exchangeName} order book information for ${pairObj.pair}. Try again later.`;
    }

    const mmDisabledNote = tradeParams.mm_isActive ? '' : ' [Note: currently market-making is disabled]';

    // Third, get target mm volume
    const currentDailyTradeVolume = exchangerUtils.estimateCurrentDailyTradeVolume();
    const currentDailyTradeVolumeString = `~${utils.formatNumber(currentDailyTradeVolume.coin1.toFixed(coin1Decimals), true)} ${coin1} (${utils.formatNumber(currentDailyTradeVolume.coin2.toFixed(coin2Decimals), true)} ${coin2})`;
    output += '\n\n**Target estimated market-making volume**:\n\n';

    if (tradeParams.mm_isActive) {
      if (tradeParams.mm_Policy === 'depth') {
        output += 'I work with **depth** market-making policy to maintain order books, and run no trades to move price or for volume.';
        output += ` If you'll change policy, with current parameters daily I will generate ${currentDailyTradeVolumeString}.`;
      } else {
        output += `With current parameters, daily I will generate ${currentDailyTradeVolumeString}`;
        if (tradeParams.mm_isPriceChangeVolumeActive) {
          output += ' plus additional volume by Price maker and Price watcher. Amount of additional volume depends on liquidity set with _/enable liq_ command.';
        } else {
          output += ', additional volume by Price maker and Price watcher is disabled.';
        }
      }
    } else {
      output += '**Market-making is disabled**.';
      output += ` If you'll enable it, with current parameters daily I will generate ${currentDailyTradeVolumeString}.`;
    }

    // Forth, get order statistics
    const { statList, statTotal } = await orderStats.getAllOrderStats(['mm', 'pm', 'pw', 'cl', 'qh', 'man'], pairObj.pair);

    const composeOrderStats = function(stats) {
      const composeLine = function(time, label) {
        if (stats[`coin1AmountTotal${time}Count`]) {
          const percentString = (totalVolume24 && time === 'Day') ? ` (${(stats[`coin1AmountTotal${time}`] / totalVolume24 * 100).toFixed(2)}%)` : '';
          return `\n${label || time} — ${stats[`coin1AmountTotal${time}Count`]} orders with ${utils.formatNumber(stats[`coin1AmountTotal${time}`].toFixed(coin1Decimals), true)} ${coin1} and ${utils.formatNumber(stats[`coin2AmountTotal${time}`].toFixed(coin2Decimals), true)} ${coin2}${percentString}`;
        } else {
          return `\n${label || time} — No orders`;
        }
      };

      let orderStatsString = `_${stats.purposeName}_:`;
      if (stats.coin1AmountTotalHourCount !== 0) {
        orderStatsString += composeLine('Hour');
      }
      if (stats.coin1AmountTotalDayCount > stats.coin1AmountTotalHourCount) {
        orderStatsString += composeLine('Day');
      }
      if (stats.coin1AmountTotalMonthCount > stats.coin1AmountTotalDayCount) {
        orderStatsString += composeLine('Month');
      }
      orderStatsString += composeLine('All', 'All time');
      return orderStatsString;
    };

    if (statTotal?.coin1AmountTotalAllCount > 0) {
      output += `\n\n**Executed order statistics**${mmDisabledNote}:`;
      statList.forEach((stats) => {
        output += `\n\n${composeOrderStats(stats)}`;
      });
      output += `\n\n${composeOrderStats(statTotal)}`;
    } else {
      output += `\n\nThe bot executed no orders on ${pairObj.pair} pair all time.`;
    }
  } catch (e) {
    log.error(`Error in stats() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

async function pair(params) {
  let output = '';

  try {
    let pair = params[0]?.toUpperCase();
    if (!pair) {
      pair = config.pair;
    }
    if (pair.indexOf('/') === -1) {
      return {
        msgNotify: '',
        msgSendBack: `Wrong pair '${pair}'. Try */pair ${config.pair}*.`,
        notifyType: 'log',
      };
    }

    if (!traderapi.features().getMarkets) {
      return {
        msgNotify: '',
        msgSendBack: 'The exchange doesn\'t support receiving market info.',
        notifyType: 'log',
      };
    }

    const info = traderapi.marketInfo(pair);
    if (!info) {
      return {
        msgNotify: '',
        msgSendBack: `Unable to receive ${pair} market info. Try */pair ${config.pair}*.`,
        notifyType: 'log',
      };
    }

    output = `${config.exchangeName} reported these details on ${pair} market:\n\n`;
    output += JSON.stringify(info, null, 3);
  } catch (e) {
    log.error(`Error in pair() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Get open orders details for accountNo
 * @param {Number} accountNo 0 is for the first trade account, 1 is for the second
 * @param {Object} tx Command Tx info
 * @param {Object} pair Trading pair
 * @returns Order details for an account
 */
async function getOrdersInfo(accountNo = 0, tx = {}, pair) {
  let output = '';
  const pairObj = orderUtils.parseMarket(pair);
  let diffStringUnknownOrdersCount = '';

  const api = traderapi;
  const ordersByType = await orderStats.ordersByType(pairObj.pair, api);
  const openOrders = await orderUtils.getOpenOrdersCached(pairObj.pair, utils.getModuleName(module.id), false, api);

  if (openOrders) {

    let diff; let sign;
    let diffStringExchangeOrdersCount = '';
    if (previousOrders?.[accountNo]?.[tx.senderId]?.[pairObj?.pair]?.openOrdersCount) {
      diff = openOrders.length - previousOrders[accountNo][tx.senderId][pairObj.pair].openOrdersCount;
      sign = diff > 0 ? '+' : '−';
      diff = Math.abs(diff);
      if (diff) diffStringExchangeOrdersCount = ` (${sign}${diff})`;
    }

    if (openOrders.length > 0) {
      output = `${config.exchangeName} open orders for ${pairObj.pair} pair: ${openOrders.length}${diffStringExchangeOrdersCount}.`;
    } else {
      output = `No open orders on ${config.exchangeName} for ${pairObj.pair}.`;
    }

    ordersByType.openOrdersCount = openOrders.length;
    ordersByType.unkLength = openOrders.length - ordersByType['all'].allOrders.length;
    if (previousOrders?.[accountNo]?.[tx.senderId]?.[pairObj?.pair]?.unkLength) {
      diff = ordersByType.unkLength - previousOrders[accountNo][tx.senderId][pairObj.pair].unkLength;
      sign = diff > 0 ? '+' : '−';
      diff = Math.abs(diff);
      if (diff) diffStringUnknownOrdersCount = ` (${sign}${diff})`;
    }

  } else {
    output = `Unable to get ${config.exchangeName} orders for ${pairObj.pair}.`;
  }

  const getDiffString = function(purpose) {
    let diff; let sign;
    let diffString = '';
    if (previousOrders?.[accountNo]?.[tx.senderId]?.[pairObj.pair]?.[purpose]?.allOrders.length >= 0) {
      diff = ordersByType[purpose].allOrders.length -
        previousOrders[accountNo][tx.senderId][pairObj.pair][purpose].allOrders.length;
      sign = diff > 0 ? '+' : '−';
      diff = Math.abs(diff);
      if (diff) diffString = ` (${sign}${diff})`;
    }
    return diffString;
  };

  const getAmountsString = function(purpose) {
    let amountsString = '';
    if (ordersByType[purpose].buyOrdersQuote || ordersByType[purpose].sellOrdersAmount) {
      amountsString = ` — ${ordersByType[purpose].buyOrdersQuote.toFixed(pairObj.coin2Decimals)} ${pairObj.coin2} buys & ${ordersByType[purpose].sellOrdersAmount.toFixed(pairObj.coin1Decimals)} ${pairObj.coin1} sells`;
    }
    return amountsString;
  };

  if (ordersByType?.['all']?.allOrders?.length > 0) {
    output += '\n\nOrders in my database:';
    Object.keys(orderCollector.orderPurposes).forEach((purpose) => {
      output += `\n${orderCollector.orderPurposes[purpose]}: ${ordersByType[purpose].allOrders.length}${getDiffString(purpose)}${getAmountsString(purpose)},`;
    });
    output = utils.trimAny(output, ',') + '.';
  } else {
    output += '\n\n' + 'No open orders in my database.';
  }

  output += `\n\nOrders which are not in my database (Unknown orders): ${ordersByType.unkLength}${diffStringUnknownOrdersCount}.`;

  previousOrders[accountNo][tx.senderId] = {};
  previousOrders[accountNo][tx.senderId][pairObj.pair] = ordersByType;

  return output;
}

/**
 * Get details for open orders of specific type for accountNo
 * @param {Number} accountNo 0 is for the first trade account, 1 is for the second
 * @param {Object} tx Command Tx info
 * @param {String} pair Trading pair
 * @param {String} type Type of orders to list
 * @param {Boolean} fullInfo Show full order info. Probably there will be line breaks and not convenient to read.
 * @returns List of open orders of specific type
 */
async function getOrdersDetails(accountNo = 0, tx = {}, pair, type, fullInfo) {
  let output = '';
  const pairObj = orderUtils.parseMarket(pair);

  const api = traderapi;
  const ordersByType = (await orderStats.ordersByType(pairObj.pair, api, false))[type]?.allOrders;

  if (ordersByType?.length) {
    output = `${config.exchangeName} ${type}-orders for ${pairObj.pair} pair: ${ordersByType.length}.\n`;

    ordersByType.sort((a, b) => b.price - a.price);

    for (const order of ordersByType) {
      output += '`';

      if (type === 'ld') {
        output += `${utils.padTo2Digits(order.ladderIndex)} `;
      }

      output += `${order.type} ${order.coin1Amount?.toFixed(pairObj.coin1Decimals)} ${order.coin1} @${order.price?.toFixed(pairObj.coin2Decimals)} ${order.coin2} for ${+order.coin2Amount?.toFixed(pairObj.coin2Decimals)} ${order.coin2}`;

      if (fullInfo) {
        output += ` ${utils.formatDate(new Date(order.date))}`;
      }

      if (type === 'ld') {
        output += ` ${order.ladderState}`;

        if (fullInfo) {
          output += ` ${order.ladderNotPlacedReason ? ' (' + order.ladderNotPlacedReason + ')' : ''}`;
        }
      }

      output += '`\n';
    }
  } else {
    output = `No ${type}-orders opened on ${config.exchangeName} for ${pairObj.pair} pair.`;
  }

  return output;
}

/**
 * Get open orders details
 * @param {Object} params Optional trade pair and type of orders
 * @param {Object} tx Command Tx info
 * @returns Notification messages
 */
async function orders(params, tx = {}) {
  let detailsType;
  let pair = params[0];

  if (Object.keys(orderCollector.orderPurposes).includes(pair?.toLowerCase())) {
    detailsType = pair; // It's an order type
    pair = config.pair;
  }

  pair = pair || config.pair;

  if (pair.indexOf('/') === -1) {
    return {
      msgNotify: '',
      msgSendBack: `Wrong pair '${pair}'. Try */orders ${config.pair}*.`,
      notifyType: 'log',
    };
  }

  detailsType = detailsType || params[1]?.toLowerCase();

  let account0Orders;
  let account1Orders;

  if (detailsType) {
    if (!Object.keys(orderCollector.orderPurposes).includes(detailsType)) {
      return {
        msgNotify: '',
        msgSendBack: `Wrong order type '${detailsType}'. Try */orders ${config.pair} man*.`,
        notifyType: 'log',
      };
    }

    const fullInfo = params[params.length - 1]?.toLowerCase() === 'full' ? true : false;

    account0Orders = await getOrdersDetails(0, tx, pair, detailsType, fullInfo);
    account1Orders = undefined;
  } else {
    account0Orders = await getOrdersInfo(0, tx, pair);
    account1Orders = undefined;
  }

  const output = account1Orders ?
      account0Orders.replace(' pair:', ' pair (account 1):').replace(`on ${config.exchangeName} for`, `on ${config.exchangeName} (account 1) for`) +
      '\n\n\n' + account1Orders.replace(' pair:', ' pair (account 2):').replace(`on ${config.exchangeName} for`, `on ${config.exchangeName} (account 2) for`) :
      account0Orders;

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Makes a price with buy or sell order of type 'man'
 * @param {Array} params Command parameters to parse
 * @param {Object} tx Income ADM transaction
 * @param {Boolean} isWebApi Other messages if isWebApi true
 * @returns Notification messages
 */
async function make(params, tx, isWebApi = false) {
  // make price 1.1 COIN2 now — buy/sell to achieve target price of 1.1 COIN2
  try {

    let msgNotify; let msgSendBack; let actionString; let priceString;

    const param = (params[0] || '').trim();
    if (!param || !['price'].includes(param)) {
      msgSendBack = 'Indicate option:\n';
      msgSendBack += `\n_price_ to buy/sell to achieve target price: */make price 1.1 ${config.coin2}.`;
      return {
        msgNotify: '',
        msgSendBack,
        notifyType: 'log',
      };
    }

    if (param === 'price') {
      try {
        let priceInfoString = '';

        const pairObj = orderUtils.parseMarket(config.pair);
        const pair = pairObj.pair;
        const coin1 = pairObj.coin1;
        const coin2 = pairObj.coin2;
        const coin1Decimals = pairObj.coin1Decimals;
        const coin2Decimals = pairObj.coin2Decimals;

        const currencies = exchangerUtils.currencies;
        const coin1Rates = Object
            .keys(currencies)
            .filter((t) => t.startsWith(coin1 + '/'))
            .map((t) => {
              const p = `${coin1}/**${t.replace(coin1 + '/', '')}**`;
              return `${p}: ${currencies[t]}`;
            })
            .join(', ');

        if (!coin1Rates.length) {
          if (!pair) {
            priceInfoString = `I can’t get rates for *${coin1} from Infoservice*.`;
          }
        } else {
          priceInfoString = `Global market rates for ${coin1}:\n${coin1Rates}.`;
        }

        if (priceInfoString) {
          priceInfoString += '\n\n';
        }

        const exchangeRatesBeforeInfo = await getRatesInfo(pair);
        const exchangeRatesBefore = exchangeRatesBeforeInfo.exchangeRates;

        if (exchangeRatesBeforeInfo.success) {
          priceInfoString += exchangeRatesBeforeInfo.ratesString;
        } else {
          return {
            msgNotify: '',
            msgSendBack: `${exchangeRatesBeforeInfo.ratesString} Try again.`,
            notifyType: 'log',
          };
        }

        let targetPrice = params[1];
        targetPrice = +targetPrice;
        if (!utils.isPositiveNumber(targetPrice)) {
          return {
            msgNotify: '',
            msgSendBack: `Incorrect ${config.coin2} target price: ${targetPrice}. Example: */make price 1.1 ${config.coin2} now*.\n\n${priceInfoString}`,
            notifyType: 'log',
          };
        }

        const verifyCoin = params[2]?.toUpperCase();
        if (!verifyCoin || verifyCoin !== config.coin2) {
          return {
            msgNotify: '',
            msgSendBack: `You must set a price in ${config.coin2}. Example: */make price 1.1 ${config.coin2} now*.\n\n${priceInfoString}`,
            notifyType: 'log',
          };
        }

        const nowOrIn = params[3]?.toUpperCase();
        let dateString = '';
        if (!nowOrIn || !['NOW'].includes(nowOrIn)) {
          return {
            msgNotify: '',
            msgSendBack: `Specify when to achieve target price of ${targetPrice.toFixed(coin2Decimals)} ${coin2}. Example: */make price 1.1 ${config.coin2} now*.\n\n${priceInfoString}`,
            notifyType: 'log',
          };
        } else if (nowOrIn === 'NOW') {
          dateString = 'now';
        }

        let isConfirmed = params[params.length-1];
        if (['-y', '-Y'].includes(isConfirmed)) {
          isConfirmed = true;
        } else {
          isConfirmed = false;
        }

        /*
          Set amount to buy or sell
          reliabilityKoef: we must be sure that we'll fill all orders in the order book,
            as users/bot can add more orders while filling these orders.
            Moreover, we should place counter-order to set new spread.
            This will not work using 2-keys trading, as we have to cancel this order to avoid SELF_TRADE later
        */
        const reliabilityKoef = utils.randomValue(1.05, 1.1);
        const orderBook = await orderUtils.getOrderBookCached(config.pair, utils.getModuleName(module.id), true);
        const orderBookInfo = utils.getOrderBookInfo(orderBook, tradeParams.mm_liquiditySpreadPercent, targetPrice);
        orderBookInfo.amountTargetPrice *= reliabilityKoef;
        orderBookInfo.amountTargetPriceQuote *= reliabilityKoef;

        const whichAccount = '';
        let priceBefore; let priceChangeSign;
        if (orderBookInfo.typeTargetPrice === 'buy') {
          priceBefore = exchangeRatesBefore.ask;
          priceChangeSign = '+';
        } else {
          priceBefore = exchangeRatesBefore.bid;
          priceChangeSign = '–';
        }
        const priceChange = utils.numbersDifferencePercent(priceBefore, targetPrice);
        priceString = `${config.pair} price of ${targetPrice.toFixed(coin2Decimals)} ${config.coin2} from ${priceBefore.toFixed(coin2Decimals)} ${config.coin2}`;
        priceString += ` (${priceChangeSign}${priceChange.toFixed(2)}%)`;
        priceString += ` ${dateString}`;

        if (orderBookInfo.typeTargetPrice === 'inSpread') {
          return {
            msgNotify: '',
            msgSendBack: `${priceString} is already in spread. **No action needed**.\n\n${priceInfoString}`,
            notifyType: 'log',
          };
        } else {
          actionString = `${orderBookInfo.typeTargetPrice} ${orderBookInfo.amountTargetPrice.toFixed(coin1Decimals)} ${config.coin1} ${orderBookInfo.typeTargetPrice === 'buy' ? 'with' : 'for'} ${orderBookInfo.amountTargetPriceQuote.toFixed(coin2Decimals)} ${config.coin2}`;
        }

        if (isConfirmed) {
          if (nowOrIn === 'NOW') {
            // Not a depth mm policy, place pm-order to make price right now
            // If 2-keys trading, execute order with key2 not to SELF_TRADE
            const order = await orderUtils.addGeneralOrder(orderBookInfo.typeTargetPrice,
                config.pair, targetPrice, orderBookInfo.amountTargetPrice, 1, orderBookInfo.amountTargetPriceQuote, pairObj,
                'pm');

            if (order?._id) {
              // After we place an order, notify about price changes
              setTimeout(async () => {
                priceInfoString = '';

                const exchangeRatesAfter = await traderapi.getRates(pair);
                if (exchangeRatesAfter) {
                  priceInfoString += `${config.exchangeName} rates for ${pair} pair:\nBefore action — bid: ${exchangeRatesBefore.bid.toFixed(coin2Decimals)}, ask: ${exchangeRatesBefore.ask.toFixed(coin2Decimals)}.`;
                  priceInfoString += `\nAfter action — bid: ${exchangeRatesAfter.bid.toFixed(coin2Decimals)}, ask: ${exchangeRatesAfter.ask.toFixed(coin2Decimals)}`;
                  priceInfoString += ' [May be not actual if cached by exchange].';
                } else {
                  priceInfoString += `Unable to get ${config.exchangeName} rates for ${pair}.`;
                }

                msgNotify = `${config.notifyName}: Making ${priceString}: Successfully placed an order${whichAccount} to *${actionString}*.\n\n${priceInfoString}`;
                msgSendBack = `Making ${priceString}: Successfully placed an order${whichAccount} to **${actionString}**.\n\n${priceInfoString}`;

                notify(msgNotify, 'log');

                if (!isWebApi) {
                  api.sendMessage(config.passPhrase, tx.senderId, msgSendBack).then((response) => {
                    if (!response.success) {
                      log.warn(`Failed to send ADM message '${msgSendBack}' to ${tx.senderId}. ${response.errorMessage}.`);
                    }
                  });
                }
              }, 7000); // If exchange doesn't cache rates, 7 sec is enough to update
            } else {
              // Unable to place pm-order
              msgNotify = '';
              msgSendBack = `Unable to make ${priceString}. The order to ${actionString} failed: it's likely not enough funds or a temporary API error. Check balances and try again.\n\n${priceInfoString}`;
            }
          }
        } else {
          // Ask for confirmation
          msgNotify = '';
          let pwWarning = ' ';
          const pw = require('../trade/mm_price_watcher');
          if (tradeParams.mm_isActive && pw.getIsPriceActualAndEnabled()) {
            if (targetPrice < pw.getLowPrice() || targetPrice > pw.getHighPrice()) {
              pwWarning = `\n\n**Warning: Target price ${targetPrice} ${config.coin2} is out of ${pw.getPwRangeString()}**`;
              if (nowOrIn === 'NOW') {
                pwWarning += ' If you confirm, the bot will restore a price then.';
                pwWarning += pw.getIsPriceRangeSetWithSupportPrice() && targetPrice < pw.getLowPrice() ? ' If you don\'t want Support price/Price watcher to interfere, update them with  _/enable sp_ & _/enable pw_ commands first.' : ' If you don\'t want Price watcher to interfere, update its range with _/enable pw_ command first.';
              }
              pwWarning += '\n\n';
            }
          }
          let actionNoteString= '';
          if (nowOrIn === 'NOW') {
            actionNoteString = 'I am going to';
          }
          msgSendBack = isWebApi ? `Are you sure to make ${priceString}? ${actionNoteString} **${actionString}**.${pwWarning}` :`Are you sure to make ${priceString}? ${actionNoteString} **${actionString}**.${pwWarning}Confirm with **/y** command or ignore.\n\n${priceInfoString}`;
        }

        setPendingConfirmation(`/make ${params.join(' ')}`);
      } catch (e) {
        log.error(`Error in make()-price of ${utils.getModuleName(module.id)} module: ${e}`);
      }
    } // if (param === "price")

    return {
      msgNotify,
      msgSendBack,
      notifyType: 'log',
    };

  } catch (e) {
    log.error(`Error in make() of ${utils.getModuleName(module.id)} module: ${e}`);
  }
}

/**
 * Get info on coin withdrawal information and networks
 * @param {Array} params Command parameters to parse
 * @param {Object} tx Income ADM transaction
 * @param {Boolean} isWebApi If isWebApi true, messages can be different
 * @returns Notification messages
 * @returns {Promise<void>}
 */
async function info(params, tx, isWebApi = false) {
  try {
    const coin = params[0]?.toUpperCase() || '';
    if (coin?.length < 2) {
      return {
        msgNotify: '',
        msgSendBack: 'Specify coin to get withdrawal information and networks. Example: */info USDT*.',
        notifyType: 'log',
      };
    }

    if (traderapi.features().getCurrencies && traderapi.currencies) {
      await traderapi.getCurrencies(coin, true);

      const currency = await traderapi.currencyInfo(coin);
      if (!currency) {
        return {
          msgNotify: '',
          msgSendBack: `It seems ${config.exchangeName} doesn't have _${coin}_ coin. Try */info USDT*.`,
          notifyType: 'log',
        };
      }

      let msgSendBack = `_${coin}_ on ${config.exchangeName} info:\n`;
      msgSendBack += coinInfoString(currency);

      return {
        msgNotify: '',
        msgSendBack,
        notifyType: 'log',
      };
    }

    return {
      msgNotify: '',
      msgSendBack: `It seems ${config.exchangeName} doesn't provide info about coins.`,
      notifyType: 'log',
    };
  } catch (e) {
    log.error(`Error in info() of ${utils.getModuleName(module.id)} module: ` + e);
  }
}

async function calc(params, tx, isWebApi = false) {
  let output = '';
  try {

    if (params.length !== 4) {
      return {
        msgNotify: '',
        msgSendBack: 'Wrong arguments. Command works like this: */calc 2.05 BTC in USDT*.',
        notifyType: 'log',
      };
    }

    const amount = +params[0];
    const inCurrency = params[1].toUpperCase().trim();
    const outCurrency = params[3].toUpperCase().trim();
    const pair = inCurrency + '/' + outCurrency;
    const pair2 = outCurrency + '/' + inCurrency;

    if (!utils.isPositiveOrZeroNumber(amount)) {
      output = `Wrong amount: _${params[0]}_. Command works like this: */calc 2.05 BTC in USD*.`;
      return {
        msgNotify: '',
        msgSendBack: `${output}`,
        notifyType: 'log',
      };
    }
    if (!exchangerUtils.hasTicker(inCurrency)) {
      output = `I don’t have rates of crypto *${inCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USDT*.`;
    }
    if (!exchangerUtils.hasTicker(outCurrency)) {
      output = `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USDT*.`;
    }

    let result;
    if (!output) {
      result = exchangerUtils.convertCryptos(inCurrency, outCurrency, amount).outAmount;
      if (!utils.isPositiveOrZeroNumber(result)) {
        output = `Unable to calc _${params[0]}_ ${inCurrency} in ${outCurrency}.`;
        return {
          msgNotify: '',
          msgSendBack: `${output}`,
          notifyType: 'log',
        };
      }

      const precision = exchangerUtils.isFiat(outCurrency) ? 2 : constants.PRECISION_DECIMALS;
      output = isWebApi ? utils.formatNumber(result.toFixed(precision), false) : `Global market value of ${utils.formatNumber(amount)} ${inCurrency} equals ${utils.formatNumber(result.toFixed(precision), true)} ${outCurrency}.`;
    } else {
      output = '';
    }

    if (output && !isWebApi) {
      output += '\n\n';
    }
    let askValue; let bidValue;

    let exchangeRates = await traderapi.getRates(pair);
    if (!isWebApi) {
      if (exchangeRates) {
        askValue = exchangeRates.ask * amount;
        bidValue = exchangeRates.bid * amount;
        output += `${config.exchangeName} value of ${utils.formatNumber(amount)} ${inCurrency}:\nBid: **${utils.formatNumber(bidValue.toFixed(8))} ${outCurrency}**, ask: **${utils.formatNumber(askValue.toFixed(8))} ${outCurrency}**.`;
      } else {
        exchangeRates = await traderapi.getRates(pair2);
        if (exchangeRates) {
          askValue = amount / exchangeRates.ask;
          bidValue = amount / exchangeRates.bid;
          output += `${config.exchangeName} value of ${utils.formatNumber(amount)} ${inCurrency}:\nBid: **${utils.formatNumber(bidValue.toFixed(8))} ${outCurrency}**, ask: **${utils.formatNumber(askValue.toFixed(8))} ${outCurrency}**.`;
        } else {
          output += `Unable to get ${config.exchangeName} rates for ${pair}.`;
        }
      }
    }

  } catch (e) {
    log.error(`Error in calc() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

/**
 * Creates a string about coin info
 * @param {Object} coin
 * @return {String}
 */
function coinInfoString(coin) {
  const networksSupported = traderapi.features().supportCoinNetworks && typeof coin.networks === 'object' && Object.keys(coin.networks)?.length;

  let message = '';
  message += `Coin status is ${buildStatusString(coin)}${coin.comment ? ': ' + utils.trimAny(coin.comment, '. ') : ''}.`;
  if (coin.type) {
    message += ` Type: ${coin.type}.`;
  }
  if (coin.decimals) {
    message += ` Decimals: ${coin.decimals}, precision: ${coin.precision?.toFixed(coin.decimals)}.`;
  }
  message += '\n';

  if (!networksSupported) {
    message += coinNetworkInfoString(coin);

    if (traderapi.features().supportCoinNetworksRestricted) {
      message += `\nNote: Receiving coin networks on ${config.exchangeName} is of private API. Try _/deposit ${coin.symbol}_ to list supported networks.`;
    }
  } else {
    message += `Supported networks for _${coin.name}_:`;
    message += supportedNetworksString(coin);
  }

  return message;
}

/**
 * Creates a string with coin's network info
 * @param {Object} coinOrNetwork Coin or coin.networks[network]
 * @param {Object} coin Coin to get parent info for a network
 * @return String
 */
function coinNetworkInfoString(coinOrNetwork, coin) {
  let message = '';

  const confirmations = coinOrNetwork.confirmations || coin?.confirmations;
  if (confirmations) {
    message += `Deposit confirmations: ${confirmations}. `;
  }

  const symbol = coinOrNetwork.symbol || coin?.symbol;
  const withdrawalFee = coinOrNetwork.withdrawalFee ?? coin?.withdrawalFee;
  const withdrawalFeeCurrency = coinOrNetwork.withdrawalFeeCurrency || coin?.withdrawalFeeCurrency || symbol;
  const minWithdrawal = coinOrNetwork.minWithdrawal || coin?.minWithdrawal;
  const maxWithdrawal = coinOrNetwork.maxWithdrawal || coin?.maxWithdrawal;
  if (utils.isPositiveOrZeroNumber(withdrawalFee) || coinOrNetwork.minWithdrawal) {
    if (utils.isPositiveOrZeroNumber(withdrawalFee)) {
      message += `Withdrawal fee — ${withdrawalFee} ${withdrawalFeeCurrency}`;
    } else {
      message += 'Withdrawal fee — unknown';
    }
    if (minWithdrawal) {
      message += `, minimum amount to withdraw ${minWithdrawal} ${symbol}`;
    }
    if (coinOrNetwork.maxWithdrawal) {
      message += `, maximum ${maxWithdrawal} ${symbol}`;
    }
  }

  message = utils.trimAny(message, '. ');

  const decimals = coinOrNetwork.decimals || coin?.decimals;
  const precision = coinOrNetwork.precision || coin?.precision;

  if (decimals) {
    if (message) {
      message += '. ';
    }

    message += `Decimals: ${decimals}, precision: ${precision?.toFixed(decimals)}`;
  }

  message = message ? message + '.' : '';

  return message;
}

/**
 * Creates a coin/network status string
 * @param {Object} coin
 * @return String
 */
function buildStatusString(coinOrNetwork) {
  let statusString = '';
  statusString = coinOrNetwork.status === 'ONLINE' ? `${coinOrNetwork.status.toLowerCase()}` : `**${coinOrNetwork.status}**`;

  if (coinOrNetwork.depositStatus || coinOrNetwork.withdrawalStatus) {
    if (coinOrNetwork.status !== coinOrNetwork.depositStatus || coinOrNetwork.status !== coinOrNetwork.withdrawalStatus) {
      statusString += ` (deposits: ${coinOrNetwork.depositStatus}, withdrawals: ${coinOrNetwork.withdrawalStatus})`;
    }
  }

  return statusString;
}

/**
 * Creates a string from supported networks on exchange
 * @param {Object} coin
 * @return String
 */
function supportedNetworksString(coin) {
  let message = '';

  for (const network of Object.keys(coin.networks)) {
    const networkStatus = buildStatusString(coin.networks[network]);
    message += `\n+ _${network}_ is ${networkStatus}. `;
    message += coinNetworkInfoString(coin.networks[network], coin);
    message = utils.trimAny(message, '. ') + '.';
  }

  return message;
}

/**
 * Creates a string for balances object, looks like total-available-frozen for each crypto
 * Adds totalBTC, totalUSD, totalNonCoin1USD, totalNonCoin1BTC to balances object
 * @param {Array of Object} balances Balances object
 * @param {String} caption Like '${config.exchangeName} balances:'
 * @param {Array} params First parameter: account type, e.g., main, trade, margin, or 'full'
 * @return {String, Object} String of balances info and Balances object with totalBTC, totalUSD, totalNonCoin1USD, totalNonCoin1BTC
 */
function balancesString(balances, caption, params) {
  let output = '';

  let totalBTC = 0; let totalUSD = 0;
  let totalNonCoin1BTC = 0; let totalNonCoin1USD = 0;

  const unknownCryptos = [];

  if (balances.length === 0) {
    output = 'All empty.';
  } else {
    output = caption;

    // Skip total-available-frozen for totals
    balances = balances.filter((crypto) => !['totalBTC', 'totalUSD', 'totalNonCoin1BTC', 'totalNonCoin1USD'].includes(crypto.code));

    // Create total-available-frozen string for each crypto in Balances object
    balances.forEach((crypto) => {
      // In requested to show balances of special account type, e.g, for margin account
      const accountTypeString = params?.[0] ? `[${crypto.accountType}] ` : '';

      output += `${accountTypeString}${utils.formatNumber(crypto.total?.toFixed(8), true)} _${crypto.code}_`;

      if (crypto.total !== crypto.free) {
        output += ` (${utils.formatNumber(crypto.free?.toFixed(8), true)} available`;

        if (crypto.freezed > 0) {
          output += ` & ${utils.formatNumber(crypto.freezed?.toFixed(8), true)} frozen`;
        }

        output += ')';
      }

      output += '\n';

      let value;
      const skipUnknownCryptos = ['BTXCRD'];

      // Incrementally count Total holdings in USD
      if (utils.isPositiveOrZeroNumber(crypto.usd)) {
        totalUSD += crypto.usd;
        if (crypto.code !== config.coin1) totalNonCoin1USD += crypto.usd;
      } else {
        value = exchangerUtils.convertCryptos(crypto.code, 'USD', crypto.total).outAmount;

        if (utils.isPositiveOrZeroNumber(value)) {
          totalUSD += value;
          if (crypto.code !== config.coin1) totalNonCoin1USD += value;
        } else if (!skipUnknownCryptos.includes(crypto.code)) {
          unknownCryptos.push(crypto.code);
        }
      }

      // Incrementally count Total holdings in BTC
      if (utils.isPositiveOrZeroNumber(crypto.btc)) {
        totalBTC += crypto.btc;
        if (crypto.code !== config.coin1) totalNonCoin1BTC += crypto.btc;
      } else {
        value = exchangerUtils.convertCryptos(crypto.code, 'BTC', crypto.total).outAmount;

        if (utils.isPositiveOrZeroNumber(value)) {
          totalBTC += value;
          if (crypto.code !== config.coin1) totalNonCoin1BTC += value;
        }
      }
    });

    output += `Total holdings ~ ${utils.formatNumber(totalUSD.toFixed(2), true)} _USD_ or ${utils.formatNumber(totalBTC.toFixed(8), true)} _BTC_`;
    output += `\nTotal holdings (non-${config.coin1}) ~ ${utils.formatNumber(totalNonCoin1USD.toFixed(2), true)} _USD_ or ${utils.formatNumber(totalNonCoin1BTC.toFixed(8), true)} _BTC_`;

    if (unknownCryptos.length) {
      output += `. Note: I didn't count unknown cryptos ${unknownCryptos.join(', ')}.`;
    }

    output += '\n';

    balances.push({
      code: 'totalUSD',
      total: totalUSD,
    });

    balances.push({
      code: 'totalBTC',
      total: totalBTC,
    });

    balances.push({
      code: 'totalNonCoin1USD',
      total: totalNonCoin1USD,
    });

    balances.push({
      code: 'totalNonCoin1BTC',
      total: totalNonCoin1BTC,
    });
  }

  return { output, balances };
}

/**
 * Create balance info string for an account, including balance difference from previous request
 * @param {Number} accountNo 0 for first account, 1 for second one
 * @param {Object} tx [deprecated] Income ADM transaction to get senderId
 * @param {String} userId senderId or userId for web
 * @param {Boolean} isWebApi If true, info messages will be different
 * @param {Array} params First parameter: account type, like main, trade, margin, or 'full'.
 *   Note: Balance difference only for 'trade' account
 * @return {String}
 */
async function getBalancesInfo(accountNo = 0, tx, isWebApi = false, params, userId) {
  let output = '';

  try {
    let balances =
      await traderapi.getBalances();
    const accountTypeString = params?.[0] ? ` _${params?.[0]}_ account` : '';
    const caption = `${config.exchangeName}${accountTypeString} balances:\n`;
    const balancesObject = balancesString(balances, caption, params);
    output = balancesObject.output;
    balances = balancesObject.balances;

    if (!isWebApi && !params?.[0]) {
      output += utils.differenceInBalancesString(
          balances,
          previousBalances[accountNo][userId],
          orderUtils.parseMarket(config.pair),
      );

      previousBalances[accountNo][userId] = { timestamp: Date.now(), balances };
    }
  } catch (e) {
    log.error(`Error in getBalancesInfo() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return output;
}

/**
 * Show account balance info
 * @param {Array} params First parameter: account type, like main, trade, margin, or 'full'.
 *   If undefined, will show balances for 'trade' account. If 'full', for all account types.
 *   Exchange should support features().accountTypes
 *   Note: Both account balances in case of two-keys trading will show only for 'trade'
 * @param {Object} tx Income ADM transaction for in-chat command
 * @param {Object} user User info for web
 * @param {Boolean} isWebApi If true, info messages will be different
 * @return {String}
 */
async function balances(params, tx, user, isWebApi = false) {
  let output = '';

  try {
    if (params?.[0]) {
      if (traderapi.features().accountTypes) {
        params[0] = params[0].toLowerCase();
      } else {
        params = {};
      }
    }

    const userId = isWebApi ? user.login : tx.senderId;

    // Get balances info for each account separately
    const account0Balances = await getBalancesInfo(0, tx, isWebApi, params, userId);
    const account1Balances = undefined;

    output = account1Balances ? account0Balances + '\n\n' + account1Balances : account0Balances;

    // Get balances info combined for two accounts (commonBalances)
    if (account0Balances && account1Balances && !isWebApi && !params?.[0]) {
      const commonBalances = utils.sumBalances(previousBalances[0][userId]?.balances, previousBalances[1][userId]?.balances);

      output += balancesString(commonBalances, '\n\n**Both accounts**:\n').output;

      const diffString = utils.differenceInBalancesString(
          commonBalances,
          previousBalances[2][userId],
          orderUtils.parseMarket(config.pair),
      );

      if (diffString) {
        output += diffString;
      }

      previousBalances[2][userId] = { timestamp: Date.now(), balances: commonBalances };
    }
  } catch (e) {
    log.error(`Error in balances() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output || 'Unable to get account balances. Check API keys, or it may be a temporary error. See logs for details.',
    notifyType: 'log',
  };
}

async function getAccountInfo(accountNo = 0, tx, isWebApi = false) {
  const paramString = `accountNo: ${accountNo}, tx: ${tx}, isWebApi: ${isWebApi}`;

  let output = '';

  try {
    const api = traderapi;

    if (traderapi.features().getTradingFees) {
      const feesBTC = config.pair === 'BTC/USDT' ? [] : await api.getFees('BTC/USDT');
      const feesCoin2 = await api.getFees(config.coin1);

      const fees = [...feesBTC, ...feesCoin2];

      output += `${config.exchangeName} trading fees:\n`;

      fees.forEach((pair) => {
        output += `_${pair.pair}_: maker ${utils.formatNumber(pair.makerRate, true)}, taker ${utils.formatNumber(pair.takerRate, true)}`;
        if (pair.takerRateStable && pair.takerRateCrypto) {
          output += `, taker-stable ${utils.formatNumber(pair.takerRateStable, true)}`;
          output += `, taker-crypto ${utils.formatNumber(pair.takerRateCrypto, true)}`;
        }
        output += '\n';
      });
      output += '\n';

    } else {
      output += `${config.exchangeName}'s API doesn't provide trading fees information.\n\n`;
    }

    if (traderapi.features().getAccountTradeVolume) {
      const tradingVolume = await api.getVolume();

      output += `${config.exchangeName} 30-days trading volume: `;

      output += `${utils.formatNumber(tradingVolume?.volume30days, true)}`;
      output += tradingVolume?.volumeUnit ? ` ${tradingVolume?.volumeUnit}` : '';
      output += tradingVolume?.updated ? ` as on ${tradingVolume?.updated}.` : '.';

    } else {
      output += `${config.exchangeName}'s API doesn't provide trading volume information.`;
    }
  } catch (e) {
    log.error(`Error in getAccountInfo(${paramString}) of ${utils.getModuleName(module.id)} module: ${e}`);
    output = 'Error while receiving account information. Try again later.';
  }

  return output;
}

async function account({}, tx, isWebApi = false) {
  let output = '';

  try {

    if (traderapi.features().getTradingFees || traderapi.features().getAccountTradeVolume) {
      const account0Info = await getAccountInfo(0, tx, isWebApi);
      const account1Info = undefined;
      output = account1Info ? account0Info + '\n\n' + account1Info : account0Info;
    } else {
      output = `${config.exchangeName}'s API doesn't provide account information.`;
    }

  } catch (e) {
    log.error(`Error in account() of ${utils.getModuleName(module.id)} module: ` + e);
  }

  return {
    msgNotify: '',
    msgSendBack: output,
    notifyType: 'log',
  };
}

function version() {
  return {
    msgNotify: '',
    msgSendBack: `I am running on _adamant-tradebot_ software version _${config.version}_. Revise code on ADAMANT's GitHub.`,
    notifyType: 'log',
  };
}

function volume() {
  return {
    msgNotify: '',
    msgSendBack: 'This is a stub.',
    notifyType: 'log',
  };
}

const aliases = {
  // Balances for all bots
  rbalances: () => ('/remote balances all'),
  rba: () => ('/remote balances all'),
  rb: () => ('/remote balances all'),
  // Orders for all bots
  roa: () => ('/remote orders all'),
  ro: () => ('/remote orders all'),
  // Clean unknown orders for all bots
  rcua: () => ('/remote clear unk all'),
  rcu: () => ('/remote clear unk all'),
  // Price watcher for all bots
  epwa: (params) => (`/remote enable pw ${params.join(' ')} {QUOTE_COIN} all`),
  epw: (params) => (`/remote enable pw ${params.join(' ')} {QUOTE_COIN} all`),
  // Make price for all bots
  rmpa: (params) => (`/remote make price ${params?.[0]} {QUOTE_COIN} ${params?.slice(1)?.join(' ')} all`),
  rmp: (params) => (`/remote make price ${params?.[0]} {QUOTE_COIN} ${params?.slice(1)?.join(' ')} all`),
  // Stop price maker for all bots (no confirmation)
  rmpas: () => ('/remote make price stop all -y'),
  rmps: () => ('/remote make price stop all -y'),
  // Support price for all bots
  rspa: (params) => (`/remote enable sp ${params.join(' ')} {QUOTE_COIN} all`),
  rsp: (params) => (`/remote enable sp ${params.join(' ')} {QUOTE_COIN} all`),
  // Start and stop all the bots
  rstopy: () => ('/remote stop mm all -y'),
  rstart: () => ('/remote start mm all'),
};

const commands = {
  help,
  rates,
  stats,
  pair,
  orders,
  calc,
  balances,
  account,
  version,
  start,
  stop,
  buypercent,
  amount,
  interval,
  clear,
  fill,
  params,
  buy,
  sell,
  enable,
  disable,
  deposit,
  make,
  y,
  volume,
  info,
  saveConfig: utils.saveConfig,
};

module.exports.commands = commands;
