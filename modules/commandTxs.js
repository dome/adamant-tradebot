const fs = require('fs');
const Store = require('../modules/Store');
const $u = require('../helpers/utils');
const config = require('./configReader');
const log = require('../helpers/log');
const notify = require('../helpers/notify');
const tradeParams = require('../trade/tradeParams_' + config.exchange);
const traderapi = require('../trade/trader_' + config.exchange)(config.apikey, config.apisecret, config.apipassword, log);
const orderCollector = require('../trade/orderCollector');
const getStats = require('../trade/orderStats');

const timeToConfirm = 1000 * 60 * 10; // 10 minutes to confirm
let pendingConfirmation = {
	command: '',
	timestamp: 0
}

module.exports = async (cmd, tx, itx) => {

	if (itx && itx.isProcessed) return;
	log.info('Got new command Tx to process: ' + cmd);
	try {
		let res = [];
		const group = cmd
			.trim()
			.replace(/    /g, ' ')
			.replace(/   /g, ' ')
			.replace(/  /g, ' ')
			.split(' ');
		const methodName = group.shift().trim().toLowerCase().replace('\/', '');
		const m = commands[methodName];
		if (m) {
			res = await m(group, tx);
		} else {
			res.msgSendBack = `I don’t know */${methodName}* command. ℹ️ You can start with **/help**.`;
		}
		if (!tx) {
			return res.msgSendBack;
		}
		if (tx) {
            if (itx) itx.update({isProcessed: true}, true);
            if (res.msgNotify)
                notify(res.msgNotify, res.notifyType);
            if (res.msgSendBack)
                $u.sendAdmMsg(tx.senderId, res.msgSendBack);
            saveConfig();
        }
	} catch (e) {
		tx = tx || {};
		log.error('Error while processing command ' + cmd + ' from senderId ' + tx.senderId + '. Tx Id: ' + tx.id + '. Error: ' + e);
	}
}

function y(params, tx) {
	try {
		if (pendingConfirmation.command) {
			if (Date.now() - pendingConfirmation.timestamp > timeToConfirm) {
				return {
					msgNotify: '',
					msgSendBack: `I will not confirm command ${pendingConfirmation.command} as it is expired. Try again.`,
					notifyType: 'log'
				}
			} else {
				module.exports(`${pendingConfirmation.command} -y`, tx);
				return {
					msgNotify: '',
					msgSendBack: '',
					notifyType: 'log'
				}
			}
		} else {
			return {
				msgNotify: '',
				msgSendBack: `There is no pending command to confirm.`,
				notifyType: 'log'
			}
		}
	} catch (e) {
		log.error(`Error in y()-confirmation of ${$u.getModuleName(module.id)} module: ` + e);
	}
	pendingConfirmation.command = '';
}

function start(params) {

	const type = (params[0] || '').trim().toLowerCase();
	if (!type || !type.length || !["mm"].includes(type)) {
        return {
            msgNotify: '',
            msgSendBack: `Indicate trade type, _mm_ for market making. Example: */start mm*.`,
            notifyType: 'log'
		} 
	}

	let policy = (params[1] || 'optimal').trim().toLowerCase();
	if (!policy || !policy.length || !["optimal", "spread", "orderbook"].includes(policy)) {
        return {
            msgNotify: '',
            msgSendBack: `Wrong market making policy. It should be _spread_, _orderbook_, or _optimal_. Example: */start mm spread*.`,
            notifyType: 'log'
		} 
	}

	if (type === "mm") {

		tradeParams.mm_isActive = true;
		tradeParams.mm_Policy = policy;

		let optionsString = '';
		let notesStringNotify = '';
		let notesStringMsg = '';

		if (tradeParams.mm_isOrderBookActive) {
			optionsString += ' & order book building';
		} else {
			notesStringNotify += ' Order book building is disabled.';
			notesStringMsg += ' Order book building is disabled—type */enable ob* to enable.';
		}

		if (tradeParams.mm_isLiquidityActive) {
			optionsString += ' & liquidity and spread maintenance';
		} else {
			notesStringNotify += ' Liquidity and spread maintenance is disabled.';
			notesStringMsg += ' Liquidity and spread maintenance is disabled—type */enable liq* to enable.';
		}

		msgNotify = `${config.notifyName} set to start market making${optionsString} with ${policy} policy for ${config.pair}.${notesStringNotify}`;
		msgSendBack = `Starting market making${optionsString} with ${policy} policy for ${config.pair} pair.${notesStringMsg}`;

		return {
			msgNotify,
			msgSendBack,
			notifyType: 'log'
		}

	}
}

function stop(params) {

	const type = (params[0] || '').trim();
	if (!type || !type.length || !["mm"].includes(type)) {
        return {
            msgNotify: '',
            msgSendBack: `Indicate trade type, _mm_ for market making. Example: */stop mm*.`,
            notifyType: 'log'
		} 
	}

	let msgNotify, msgSendBack;

	if (type === "mm") {

		let optionsString = ', order book building, liquidity and spread maintenance';

		if (tradeParams.mm_isActive) {
			msgNotify = `${config.notifyName} stopped Market making${optionsString} for ${config.pair} pair.`;
			msgSendBack = `Market making${optionsString} for ${config.pair} pair is disabled now.`;
		} else {
			msgNotify = '';
			msgSendBack = `Market making for ${config.pair} pair is disabled already.`;
		}

		tradeParams.mm_isActive = false;

	}

	return {
		msgNotify,
		msgSendBack,
		notifyType: 'log'
	} 

}

function enable(params) {

	// enable ob 15 — enable order book building with X maximum number of orders
	// enable liq 2% 1000 ADM 50 USDT downtrend — provide liquidity with maximum of 1000 ADM asks (sell) and 50 USDT bids (buy) within 2% spread & keep average price lower
		// downtrend, uptrend, middle

	const type = (params[0] || '').trim();
	if (!type || !type.length || !["ob", "liq"].includes(type)) {
        return {
            msgNotify: '',
            msgSendBack: `Indicate option: _ob_ for order book building, _liq_ for liquidity and spread maintenance. Example: */enable ob 15*.`,
            notifyType: 'log'
		} 
	}

	let msgNotify, msgSendBack, infoString, notesStringNotify, notesStringMsg, optionsString;

	if (type === "ob") {

		const orderBookOrdersCount = +params[1];
		tradeParams.mm_isOrderBookActive = true;
		if (orderBookOrdersCount && orderBookOrdersCount != Infinity)
			tradeParams.mm_orderBookOrdersCount = orderBookOrdersCount;
		else if (!orderBookOrdersCount.length && !tradeParams.mm_orderBookOrdersCount)
			orderBookOrdersCount = 15; // default for mm_orderBookOrdersCount

		infoString = `with ${tradeParams.mm_orderBookOrdersCount} maximum number of orders`;	
		optionsString = `Order book building`;

	} else if (type === "liq") {

		const spreadString = params[1];
		// console.log(spreadString);

		if (!spreadString || (spreadString.slice(-1) !== '%')) {
			return {
				msgNotify: '',
				msgSendBack: `Set a spread in percentage. Example: */enable liq 2% 1000 ADM 50 USDT uptrend*.`,
				notifyType: 'log'
			}	
		}
		const spreadValue = +spreadString.slice(0, -1);
		// console.log(spreadValue);
		if (!spreadValue || spreadValue === Infinity || spreadValue <= 0 || spreadValue > 80) {
			return {
				msgNotify: '',
				msgSendBack: `Set correct spread in percentage. Example: */enable liq 2% 1000 ADM 50 USDT uptrend*.`,
				notifyType: 'log'
			}
		}

		const coin1 = params[3].toUpperCase();
		const coin2 = params[5].toUpperCase();
		// console.log(coin1, coin2);

		if (!coin1 || !coin2 || coin1 === coin2 || (![config.coin1, config.coin2].includes(coin1)) || (![config.coin1, config.coin2].includes(coin2))) {
			return {
				msgNotify: '',
				msgSendBack: `Incorrect liquidity coins. Config is set to trade ${config.pair} pair. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
				notifyType: 'log'
			}
		}
		// console.log(coin1, coin2, "good");

		const coin1Amount = +params[2];
		// console.log(coin1Amount);

		if (!coin1Amount || coin1Amount === Infinity || coin1Amount <= 0) {
			return {
				msgNotify: '',
				msgSendBack: `Incorrect ${coin1} amount: ${coin1Amount}. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
				notifyType: 'log'
			}
		}
		// console.log(coin1Amount, "good");

		const coin2Amount = +params[4];
		// console.log(coin2Amount);

		if (!coin2Amount || coin2Amount === Infinity || coin2Amount <= 0) {
			return {
				msgNotify: '',
				msgSendBack: `Incorrect ${coin2} amount: ${coin2Amount}. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
				notifyType: 'log'
			}
		}
		// console.log(coin2Amount, "good");

		let trend = params[6];
		// console.log(trend);

		if (!trend) {
			trend = 'middle';
		}

		trend = trend.toLowerCase();;

		if ((!['middle', 'downtrend', 'uptrend'].includes(trend))) {
			return {
				msgNotify: '',
				msgSendBack: `Incorrect trend. Example: */enable liq 2% 100 ${config.coin1} 50 ${config.coin2} uptrend*.`,
				notifyType: 'log'
			}
		}
		// console.log(trend, "good");

		if (coin1 === config.coin1) {
			tradeParams.mm_liquiditySellAmount = coin1Amount;
			tradeParams.mm_liquidityBuyAmount = coin2Amount;
		} else {
			tradeParams.mm_liquiditySellAmount = coin2Amount;
			tradeParams.mm_liquidityBuyAmount = coin1Amount;
		}
		// console.log(tradeParams.mm_liquiditySellAmount, tradeParams.mm_liquidityBuyAmount);

		tradeParams.mm_liquidityTrend = trend;
		tradeParams.mm_liquiditySpreadPercent = spreadValue;
		tradeParams.mm_isLiquidityActive = true;
		
		if (trend === 'middle')
			trend = 'middle trend';
		infoString = `with ${tradeParams.mm_liquiditySellAmount} ${config.coin1} asks (sell) and ${tradeParams.mm_liquidityBuyAmount} ${config.coin2} bids (buy) within ${spreadValue}% spread & ${trend}`;
		optionsString = `Liquidity and spread maintenance`;

	}

	if (tradeParams.mm_isActive) {
		msgNotify = `${config.notifyName} enabled ${optionsString} for ${config.pair} pair ${infoString}.`;
		msgSendBack = `${optionsString} is enabled for ${config.pair} pair ${infoString}.`;
	} else {
		notesStringNotify = ` Market making and ${optionsString} are not started yet.`
		notesStringMsg = ` To start Market making and ${optionsString}, type */start mm*.`
		msgNotify = `${config.notifyName} enabled ${optionsString} for ${config.pair} pair ${infoString}.${notesStringNotify}`;
		msgSendBack = `${optionsString} is enabled for ${config.pair} pair ${infoString}.${notesStringMsg}`;
	}

	return {
		msgNotify,
		msgSendBack,
		notifyType: 'log'
	}
	
}

function disable(params) {

	const type = (params[0] || '').trim();
	if (!type || !type.length || !["ob", "liq"].includes(type)) {
        return {
            msgNotify: '',
            msgSendBack: `Indicate option: _ob_ for order book building, _liq_ for liquidity and spread maintenance. Example: */disable ob*.`,
            notifyType: 'log'
		} 
	}

	let msgNotify, msgSendBack, optionsString;

	if (type === "ob") {
		tradeParams.mm_isOrderBookActive = false;
		optionsString = `Order book building`;
	} else if (type === "liq") {
		tradeParams.mm_isLiquidityActive = false;
		optionsString = `Liquidity and spread maintenance`;
	}

	if (tradeParams.mm_isActive) {
		msgNotify = `${config.notifyName} disabled ${optionsString} for ${config.pair} pair. Market making is still active.`;
		msgSendBack = `${optionsString} is disabled for ${config.pair} pair. Market making is still active. To stop market making, type */stop mm*. To close current ob-orders, type */clear ob*. To close current liq-orders, type */clear liq*.`;
	} else {
		msgNotify = `${config.notifyName} disabled ${optionsString} for ${config.pair}.`;
		msgSendBack = `${optionsString} is disabled for ${config.pair}.`;
	}

	return {
		msgNotify,
		msgSendBack,
		notifyType: 'log'
	}

}

function buypercent(param) {
	const val = +((param[0] || '').trim());
	if (!val || val === Infinity || val < 0 || val > 100) {
        return {
            msgNotify: '',
            msgSendBack: `Invalid percentage of buy orders. Example: */buyPercent 85*.`,
            notifyType: 'log'
		} 
	}

	tradeParams.mm_buyPercent = val / 100;
	return {
		msgNotify: `${config.notifyName} is set to make market with ${val}% of buy orders for ${config.pair} pair. Order book building is set to ${100-val}% of buy orders.`,
		msgSendBack: `Set to make market with ${val}% of buy orders for ${config.pair} pair. Order book building is set to ${100-val}% of buy orders.`,
		notifyType: 'log'
	}
}

function amount(param) {
	const val = (param[0] || '').trim();
	if (!val || !val.length || (val.indexOf('-') === -1)) {
        return {
            msgNotify: '',
            msgSendBack: `Invalid values for market making of ${config.pair}. Example: */amount 0.01-20*.`,
            notifyType: 'log'
		} 
	}
	const [minStr, maxStr] = val.split('-');
	const min = +minStr;
	const max = +maxStr;
	if (!min || min === Infinity || !max || max === Infinity){
        return {
            msgNotify: '',
            msgSendBack: `Invalid values for market making of ${config.pair}. Example: */amount 0.01-20*.`,
            notifyType: 'log'
		} 
	}
	tradeParams.mm_minAmount = min;
	tradeParams.mm_maxAmount = max;
	return {
		msgNotify: `${config.notifyName} is set to make market with amounts from ${min} to ${max} ${config.coin1} for ${config.pair} pair.`,
		msgSendBack: `Set to make market with amounts from ${min} to ${max} ${config.coin1} for ${config.pair} pair.`,
		notifyType: 'log'
	}
}

function interval(param) {
	const val = (param[0] || '').trim();
	if (!val || !val.length || (val.indexOf('-') === -1)) {
        return {
            msgNotify: '',
            msgSendBack: `Invalid intervals for market making of ${config.pair}. Example: */interval 1-5 min*.`,
            notifyType: 'log'
		} 
	}

	let time = (param[1] || '').trim();
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
			multiplier = 1000*60;
			time = 'min';
	}

	const [minStr, maxStr] = val.split('-');
	const min = +minStr;
	const max = +maxStr;
	if (!min || min === Infinity || !max || max === Infinity) {
        return {
            msgNotify: '',
            msgSendBack: `Invalid intervals for market making of ${config.pair}. Example: */interval 1-5 min*.`,
            notifyType: 'log'
		} 
	}
	tradeParams.mm_minInterval = min * multiplier;
	tradeParams.mm_maxInterval = max * multiplier;
	return {
		msgNotify: `${config.notifyName} is set to make market in intervals from ${min} to ${max} ${time} for ${config.pair} pair.`,
		msgSendBack: `Set to make market in intervals from ${min} to ${max} ${time} for ${config.pair} pair.`,
		notifyType: 'log'
	}
}

async function clear(params) {

	let pair = params[0].toUpperCase();
	if (!pair || pair.indexOf('/') === -1) {
		pair = config.pair;
	}

	if (!pair || !pair.length) {
		return {
			msgNotify: ``,
			msgSendBack: 'Please specify market to clear orders in. F. e., */clear DOGE/BTC mm*.',
			notifyType: 'log'
		}	
	}

	let purposes;
	let purposeString;

	params.forEach(param => {

		if (['all'].includes(param)) {
			// purposes = ['mm', 'tb', 'ob', 'liq', 'pw'];
			purposes = 'all';
		}
		if (['tb'].includes(param)) {
			purposes = ['tb'];
			purposeString = `trade bot`;
		}
		if (['ob'].includes(param)) {
			purposes = ['ob'];
			purposeString = `order book`;
		}
		if (['liq'].includes(param)) {
			purposes = ['liq'];
			purposeString = `liquidity`;
		}
		if (['pw'].includes(param)) {
			purposes = ['pw'];
			purposeString = `price watcher`;
		}
	});
	if (!purposes) {
		purposes = ['mm'];
		purposeString = `market making`;
	}

	let output = '';
	let count = 0;
	// console.log(purposes, count, output);

	// First, close orders which are in bot's database
	count = await orderCollector(purposes, pair);

	// Next, if need to clear all orders, close orders which are not closed yet
	if (purposes === 'all') {

		const openOrders = await traderapi.getOpenOrders(pair);
		if (openOrders) {
			if ((count + openOrders.length) > 0) {
				output = `Clearing **all** ${count + openOrders.length} orders for ${pair} pair on ${config.exchangeName}..`;
				openOrders.forEach(order => {
					traderapi.cancelOrder(order.orderid, order.side, order.symbol);
				});
			} else {
				output = `No open orders on ${config.exchangeName} for ${pair}.`;
			}
		} else {
			output = `Unable to get ${config.exchangeName} orders for ${pair}.`;
		}

	} else {

		if (count > 0) {
			output = `Clearing ${count} **${purposeString}** orders for ${pair} pair on ${config.exchangeName}..`;
		} else {
			output = `No open **${purposeString}** orders on ${config.exchangeName} for ${pair}.`;
		}	

	}

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function fill(params) {

	// default: low=bid, count=5, pair=ADM/BTC
	// fill ADM/BTC buy amount=0.00002000 low=0.00000102 high=0.00000132 count=7 

	// default: high=ask, count=5, ADM/BTC
	// fill ADM/BTC sell amount=300 low=0.00000224 high=0.00000380 count=7

	let count, amount, low, high;
	params.forEach(param => {
		try {
			if (param.startsWith('count')) {
				count = +param.split('=')[1].trim();
			}
			if (param.startsWith('amount')) {
				amount = +param.split('=')[1].trim();
			}
			if (param.startsWith('low')) {
				low = +param.split('=')[1].trim();
			}
			if (param.startsWith('high')) {
				high = +param.split('=')[1].trim();
			}
		} catch (e) {
			return {
				msgNotify: ``,
				msgSendBack: 'Wrong arguments. Command works like this: */fill ADM/BTC buy amount=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
				notifyType: 'log'
			}	
		}
	});

	if (params.length < 3) {
		return {
			msgNotify: ``,
			msgSendBack: 'Wrong arguments. Command works like this: */fill ADM/BTC buy amount=0.00002000 low=0.00000100 high=0.00000132 count=7*.',
			notifyType: 'log'
		}
	}

	let output = '';
	let type;
	const pairObj = $u.getPairObj(params[0]);
	const pair = pairObj.pair;
	const coin1 = pairObj.coin1;
	const coin2 = pairObj.coin2;
	const coin1Decimals =  pairObj.coin1Decimals;
	const coin2Decimals =  pairObj.coin2Decimals;
	if (pairObj.isPairFromParam) {
		type = params[1].trim();
	} else {
		type = params[0].trim();
	}

	if (!pair || !pair.length) {
		output = 'Please specify market to fill orders in.';
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}

	if (!count || count === Infinity || count < 1)
		count = 5; // default

	if (!high || high === Infinity || !low || low === Infinity) {
		const exchangeRates = await traderapi.getRates(pair);
		if (exchangeRates) {
			if (!low || low === Infinity)
				low = exchangeRates.bid;
			if (!high || high === Infinity)
				high = exchangeRates.ask;
		} else {
			output = `Unable to get ${config.exchangeName} rates for ${pair} to fill orders.`;
			return {
				msgNotify: ``,
				msgSendBack: `${output}`,
				notifyType: 'log'
			}	
		}
	}

	// console.log(pair, type, count, amount, low, high);

	if (low > high) {
		output = `To fill orders _high_ should be greater than _low_.`;
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}
	}

	const balances = await traderapi.getBalances(false);
	let balance;
	let isBalanceEnough = true;
	if (balances) {
		try {
			if (type === 'buy') {
				balance = balances.filter(crypto => crypto.code === coin2)[0].free;
				output = `Not enough ${coin2} to fill orders. Check balances.`;
			} else {
				balance = balances.filter(crypto => crypto.code === coin1)[0].free; 
				output = `Not enough ${coin1} to fill orders. Check balances.`;
			}
			isBalanceEnough = balance >= amount;
		} catch (e) {
			output = `Unable to process balances. Check parameters.`;
			return {
				msgNotify: ``,
				msgSendBack: `${output}`,
				notifyType: 'log'
			}	
		}
	} else {
		output = `Unable to get ${config.exchangeName} balances. Try again.`;
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}
	}

	if (!isBalanceEnough) {
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}
	}

	// Make order list
	let orderList = [];
	const delta = high - low;
	const step = delta / count;
	const orderAmount = amount / count;
	const deviation = 0.9;

	let price = low;
	let total = 0, coin1Amount = 0, coin2Amount = 0;
	for (let i=0; i < count; i++) {
		price += $u.randomDeviation(step, deviation);
		coin1Amount = $u.randomDeviation(orderAmount, deviation);
		total += coin1Amount;

		// Checks if total or price exceeded
		if (total > amount) {
			if (count === 1)
				coin1Amount = amount
			else
				break;
		}
		if (price > high) {
			if (count === 1)
				price = high
			else
				break;
		}

		// Count base and quote currency amounts
		if (type === 'buy') {
			coin2Amount = coin1Amount;
			coin1Amount = coin1Amount / price;
		} else {
			coin1Amount = coin1Amount;
			coin2Amount = coin1Amount * price;
		}
		// console.log(price, coin1Amount, total);
		orderList.push({
			price: price,
			amount: coin1Amount,
			altAmount: coin2Amount
		});
	}

	// console.log(orderList, orderList.length);

	// Place orders
	let total1 = 0, total2 = 0;
	items = 0;
	let id;
	for (i=0; i < orderList.length; i++) {
		id = (await traderapi.placeOrder(type, pair, orderList[i].price, orderList[i].amount, 1, null, pairObj)).orderid;
		if (id) {
			items += 1;
			total1 += +orderList[i].amount;
			total2 += +orderList[i].altAmount;
		}
	}

	if (items > 0)
		output = `${items} orders to ${type} ${$u.thousandSeparator(+total1.toFixed(coin1Decimals), false)} ${coin1} for ${$u.thousandSeparator(+total2.toFixed(coin2Decimals), false)} ${coin2}.`;
	else
		output = `No orders were placed. Check log file for details.`;

	return {
		msgNotify: items > 0 ? `${config.notifyName} placed ${output}` : '',
		msgSendBack: items > 0 ? `Placed ${output}` : output,
		notifyType: 'log'
	}

}

async function buy(params) {

	let result = getBuySellParams(params, 'buy');
	return await buy_sell(result, 'buy');

}

async function sell(params) {

	let result = getBuySellParams(params, 'sell');
	return await buy_sell(result, 'sell');

}

function getBuySellParams(params, type) {

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

	let amount, quote, price = 'market';
	params.forEach(param => {
		try {
			if (param.startsWith('quote')) {
				quote = +param.split('=')[1].trim();
			}
			if (param.startsWith('amount')) {
				amount = +param.split('=')[1].trim();
			}
			if (param.startsWith('price')) {
				price = param.split('=')[1].trim();
				if (price.toLowerCase() === 'market')
					price = 'market'
				else
					price = +price;
			}
		} catch (e) {
			return {
				msgNotify: ``,
				msgSendBack: 'Wrong arguments. Command works like this: */sell ADM/BTC amount=200 price=market*.',
				notifyType: 'log'
			}	
		}
	});

	if (params.length < 1) {
		return {
			msgNotify: ``,
			msgSendBack: 'Wrong arguments. Command works like this: */sell ADM/BTC amount=200 price=market*.',
			notifyType: 'log'
		}
	}

	if ((quote && amount) || (!quote && !amount)) {
		return {
			msgNotify: ``,
			msgSendBack: 'You should specify amount _or_ quote, and not both of them.',
			notifyType: 'log'
		}
	}

	let amountOrQuote = quote || amount;

	let output = '';
	if (((!price || price === Infinity || price <= 0) && (price != 'market')) || (!amountOrQuote || amountOrQuote === Infinity || amountOrQuote <= 0)) {
		output = `Incorrect params: ${amountOrQuote}, ${price}. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}

	// when Market order, buy should pass quote parameter, when sell — amount
	const allowBuyAmountExchanges = ['resfinex', 'atomars'];
	if (price === 'market' && !allowBuyAmountExchanges.includes(config.exchange)) {
		if ((type === 'buy' && !quote) || ((type === 'sell' && !amount))) {
			output = `When placing Market order, buy should follow with _quote_, sell with _amount_. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
			return {
				msgNotify: ``,
				msgSendBack: `${output}`,
				notifyType: 'log'
			}	
		}
	}

	const amountNecessaryExchanges = ['resfinex', 'atomars'];
	if (price === 'market' && amountNecessaryExchanges.includes(config.exchange)) {
		if (!amount) {
			output = `When placing Market order on ${config.exchangeName}, _amount_ is necessary. Command works like this: */sell ADM/BTC amount=200 price=market*.`;
			return {
				msgNotify: ``,
				msgSendBack: `${output}`,
				notifyType: 'log'
			}	
		}
	}

	const pairObj = $u.getPairObj(params[0]);
	const pair = pairObj.pair;
	const coin1 = pairObj.coin1;
	const coin2 = pairObj.coin2;
	const coin1Decimals =  pairObj.coin1Decimals;
	const coin2Decimals =  pairObj.coin2Decimals;

	if (!pair || !pair.length) {
		output = 'Please specify market to make an order.';
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}

	return {
		amount,
		price, 
		quote,
		pair,
		coin1,
		coin2,
		coin1Decimals,
		coin2Decimals,
		pairObj
	}	

}

async function buy_sell(params, type) {

	if (params.msgSendBack)
		return params;

	if (!params.amount) {
		params.amount = params.quote / params.price;
	} else {
		params.quote = params.amount * params.price;
	}

	let result;
	if (params.price === 'market') {
		result = await traderapi.placeOrder(type, params.pair, null, params.amount, 0, params.quote, params.pairObj);
	} else {
		result = await traderapi.placeOrder(type, params.pair, params.price, params.amount, 1, params.quote, params.pairObj);
	}

	return {
		msgNotify: `${config.notifyName}: ${result.message}`,
		msgSendBack: result.message,
		notifyType: 'log'
	}

}

function params() {

	// console.log(tradeParams);
	let output = `I am set to work with ${config.pair} pair on ${config.exchangeName}. Current trading settings:`;
	output += "\n\n" + JSON.stringify(tradeParams, null, 3);;

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

function help() {

	let output = `I am **online** and ready to trade. I can do trading and market making, and also can give you market info.`;

	output += `

Commands:

**/rates**: Find out the market price of the coin and/or the ask and bid prices on the exchange for the trading pair. F. e., */rates ADM* or */rates ADM/BTC*.

**/stats**: Show information on the trading pair on the exchange. Prices, trading volumes and market making stats. Like */stats* or */stats ETH/BTC*.

**/orders**: Display the number of active orders for the trading pair. Example: */orders ADM/BTC*.

**/calc**: Calculate the price of one cryptocurrency in another at the market price and at the exchange prices. Works like this: */calc 2.05 BTC in USDT*.

**/balances**: Display your balances on the exchange

**/start**: Start trading (td) or market making (mm). F. e., /*start mm*.

**/stop**: Stop trading (td) or market making (mm). F. e., /*stop mm*.

**/enable**: Enable option, *ob* or *liq*. F. e., /*enable ob 10* to enable order book building with 10 maximum number of orders.

**/disable**: Disable option. F. e., /*disable ob* to disable order book building.

**/amount**: Set the amount range for market making orders. Example: */amount 0.1-20*.

**/interval**: Set the frequency in [sec, *min*, hour] of transactions for market making. Example: */interval 1-5 min*.

**/buyPercent**: Set the percentage of buy orders for market making, and 100-percentage of buy orders for order book building. Try */buyPercent 75*.

**/fill**: Fill sell or buy order book. Works like this: */fill ADM/BTC buy amount=0.00200000 low=0.00000050 high=0.00000182 count=7*.

**/buy** and **/sell**: Place a limit or market order. If _price_ is not specified, market order placed. Examples: */buy ADM/BTC amount=200 price=0.00000224* — buy 200 ADM at 0.00000224 BTC. */sell ADM/BTC quote=0.01 price=0.00000224* — sell ADM to get 0.01 BTC at 0.00000224 BTC. */sell ADM/BTC amount=200* — sell 200 ADM at market price.

**/clear**: Cancel [*mm*, td, all] active orders. F. e., */clear ETH/BTC all* or just */clear* for mm-orders of default pair.

**/deposit**: Show a deposit address for a coin. Try */deposit ADM*.

**/params**: Show current trading settings

**/version**: Show bot’s software version

Happy trading!
`;

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function rates(params) {

	let output = '';

	// if coin1 only, treat it as pair set in config
	if (params[0].toUpperCase().trim() === config.coin1)
		params[0] = config.pair;

	const pairObj = $u.getPairObj(params[0], false);
	const pair = pairObj.pair;
	const coin1 = pairObj.coin1;
	const coin2 = pairObj.coin2;
	const coin1Decimals =  pairObj.coin1Decimals;
	const coin2Decimals =  pairObj.coin2Decimals;

	if (!coin1 || !coin1.length) {
		output = 'Please specify coin ticker or specific market you are interested in. F. e., */rates ADM* or */rates ETH/BTC*.';
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}
	const currencies = Store.currencies;
	const res = Object
		.keys(Store.currencies)
		.filter(t => t.startsWith(coin1 + '/'))
		.map(t => {
			let p = `${coin1}/**${t.replace(coin1 + '/', '')}**`;
			return `${p}: ${currencies[t]}`;
		})
		.join(', ');

	if (!res.length) {
		if (!pair) {
			output = `I can’t get rates for *${coin1} from Infoservice*. Try */rates ADM*.`;
			return {
				msgNotify: ``,
				msgSendBack: `${output}`,
				notifyType: 'log'
			}
		}
	} else {
		output = `Global market rates for ${coin1}:
${res}.`;
	}

	if (pair) {
		const exchangeRates = await traderapi.getRates(pair);
		if (output)
			output += "\n\n";
		if (exchangeRates) {
			output += `${config.exchangeName} rates for ${pair} pair:\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}.`;
		} else {
			output += `Unable to get ${config.exchangeName} rates for ${pair}.`;
		}
	}

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function deposit(params) {

	let output = '';

	const pairObj = $u.getPairObj(params[0], true);
	const pair = pairObj.pair;
	const coin1 = pairObj.coin1;

	if (!coin1 || !coin1.length || pair) {
		output = 'Please specify coin to get a deposit address. F. e., */deposit ADM*.';
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}

	const depositAddress = await traderapi.getDepositAddress(coin1);
	if (depositAddress) {
		output = `The deposit address for ${coin1}: ${depositAddress}`;
	} else {
		output = `Unable to get a deposit address for ${coin1}.`;
		const dontCreateAddresses = ['coindeal'];
		if (dontCreateAddresses.includes(config.exchange)) {
			output += ` Note: ${config.exchangeName} don't create new deposit addresses via API. Create it manually with a website.`;
		}
	}

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function stats(params) {

	let output = '';

	const pairObj = $u.getPairObj(params[0]);
	const pair = pairObj.pair;
	const coin1 = pairObj.coin1;
	const coin2 = pairObj.coin2;
	const coin1Decimals =  pairObj.coin1Decimals;
	const coin2Decimals =  pairObj.coin2Decimals;

	if (!pair || !pair.length) {
		output = 'Please specify market you are interested in. F. e., */stats ETH/BTC*.';
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}

	if (pair) {
		const exchangeRates = await traderapi.getRates(pair);
		if (exchangeRates) {
			let volume_Coin2 = '';
			if (exchangeRates.volume_Coin2) {
				volume_Coin2 = ` & ${$u.thousandSeparator(+exchangeRates.volume_Coin2.toFixed(coin2Decimals), true)} ${coin2}`;
			}
			output += `${config.exchangeName} 24h stats for ${pair} pair:`;
			output += `\nVol: ${$u.thousandSeparator(+exchangeRates.volume.toFixed(coin1Decimals), true)} ${coin1}${volume_Coin2}. High: ${exchangeRates.high.toFixed(coin2Decimals)}, low: ${exchangeRates.low.toFixed(coin2Decimals)}, delta: _${(exchangeRates.high-exchangeRates.low).toFixed(coin2Decimals)}_ ${coin2}.`;
			output += `\nBid: ${exchangeRates.bid.toFixed(coin2Decimals)}, ask: ${exchangeRates.ask.toFixed(coin2Decimals)}, spread: _${(exchangeRates.ask-exchangeRates.bid).toFixed(coin2Decimals)}_ ${coin2}.`;
		} else {
			output += `Unable to get ${config.exchangeName} stats for ${pair}.`;
		}
	}

	let orderStats = await getStats(true, true, false, "mm", pair);

	if (orderStats) {
		if (orderStats === 'Empty' || orderStats.coin1AmountTotalAllCount === 0) {
			output += "\n\n" + `There were no Market making orders for ${pair} all time.`
		} else {
			output += "\n\n" + `Market making stats for ${pair} pair:` + "\n";
			if (orderStats.coin1AmountTotalDayCount != 0) {
				output += `24h: ${orderStats.coin1AmountTotalDayCount} orders with ${$u.thousandSeparator(+orderStats.coin1AmountTotalDay.toFixed(coin1Decimals), true)} ${coin1} and ${$u.thousandSeparator(+orderStats.coin2AmountTotalDay.toFixed(coin2Decimals), true)} ${coin2}`
			} else {
				output += `24h: no orders`;
			}
			if (orderStats.coin1AmountTotalMonthCount > orderStats.coin1AmountTotalDayCount) {
				output += `, 30d: ${orderStats.coin1AmountTotalMonthCount} orders with ${$u.thousandSeparator(+orderStats.coin1AmountTotalMonth.toFixed(coin1Decimals), true)} ${coin1} and ${$u.thousandSeparator(+orderStats.coin2AmountTotalMonth.toFixed(coin2Decimals), true)} ${coin2}`
			} else if (orderStats.coin1AmountTotalMonthCount === 0) {
				output += `30d: no orders`;
			}
			if (orderStats.coin1AmountTotalAllCount > orderStats.coin1AmountTotalMonthCount) {
				output += `, all time: ${orderStats.coin1AmountTotalAllCount} orders with ${$u.thousandSeparator(+orderStats.coin1AmountTotalAll.toFixed(coin1Decimals), true)} ${coin1} and ${$u.thousandSeparator(+orderStats.coin2AmountTotalAll.toFixed(coin2Decimals), true)} ${coin2}`
			}
			output += '.';
		}
	} else {
		output += "\n\n" + `Unable to get Market making stats for ${pair}.`;
	}

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function orders(params) {

	let output = '';

	const pairObj = $u.getPairObj(params[0]);
	const pair = pairObj.pair;
	const coin1 = pairObj.coin1;
	const coin2 = pairObj.coin2;
	const coin1Decimals =  pairObj.coin1Decimals;
	const coin2Decimals =  pairObj.coin2Decimals;

	if (!pair || !pair.length) {
		output = 'Please specify market you are interested in. F. e., */orders ADM/BTC*.';
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}	
	}

	if (pair) {
		const openOrders = await traderapi.getOpenOrders(pair);
		// console.log(openOrders);
		if (openOrders) {
			if (openOrders.length > 0)
				output = `${config.exchangeName} open orders for ${pair} pair: ${openOrders.length}.`;
			else 
				output = `No open orders on ${config.exchangeName} for ${pair}.`;
		} else {
			output = `Unable to get ${config.exchangeName} orders for ${pair}.`;
		}
	}

	// console.log($u.getOrderBookInfo(await traderapi.getOrderBook(pair), 30));


	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function make(params, tx, confirmation) {

	// make price 1.1 — buy/sell to achieve target price of 1.1 COIN2

	try {

		const param = (params[0] || '').trim();
		if (!param || !param.length || !["price"].includes(param)) {
			return {
				msgNotify: '',
				msgSendBack: `Indicate option: _price_ to buy/sell to achieve target price. Example: */make price 1.1*.`,
				notifyType: 'log'
			} 
		}

		let msgNotify, msgSendBack, actionString, priceString;

		if (param === "price") {

			let priceInfoString = '';

			const pairObj = $u.getPairObj(config.pair, false);
			const pair = pairObj.pair;
			const coin1 = pairObj.coin1;
			const coin2 = pairObj.coin2;
			const coin1Decimals =  pairObj.coin1Decimals;
			const coin2Decimals =  pairObj.coin2Decimals;

			const currencies = Store.currencies;
			const res = Object
				.keys(Store.currencies)
				.filter(t => t.startsWith(coin1 + '/'))
				.map(t => {
					let p = `${coin1}/**${t.replace(coin1 + '/', '')}**`;
					return `${p}: ${currencies[t]}`;
				})
				.join(', ');

			if (!res.length) {
				if (!pair) {
					priceInfoString = `I can’t get rates for *${coin1} from Infoservice*.`;
				}
			} else {
				priceInfoString = `Global market rates for ${coin1}:\n${res}.`;
			}

			const exchangeRatesBefore = await traderapi.getRates(pair);
			if (priceInfoString)
				priceInfoString += "\n\n";
			if (exchangeRatesBefore) {
				priceInfoString += `${config.exchangeName} rates for ${pair} pair:\nBid: ${exchangeRatesBefore.bid.toFixed(coin2Decimals)}, ask: ${exchangeRatesBefore.ask.toFixed(coin2Decimals)}, .`;
			} else {
				priceInfoString += `Unable to get ${config.exchangeName} rates for ${pair}.`;
			}

			let targetPrice = +params[1];
			if (!targetPrice || targetPrice === Infinity || targetPrice <= 0) {
				return {
					msgNotify: '',
					msgSendBack: `Incorrect ${config.coin2} target price: ${targetPrice}. Example: */make price 1.1*.\n\n${priceInfoString}`,
					notifyType: 'log'
				}
			}

			isConfirmed = params[2];
			if (isConfirmed && (['-y', '-Y'].includes(isConfirmed))) {
				confirmation = true;
			} else {
				confirmation = false;
			}

			// get amount from orderBook to but or sell

			/* reliabilityKoef: we must be sure that we'll fill all orders in the order book,
			   and users/bot can add more orders while filling these orders
			   Moreover, we should place counter-order to set new spread
			*/
			const reliabilityKoef = $u.randomValue(1.05, 1.1);
			let orderBookInfo = $u.getOrderBookInfo(await traderapi.getOrderBook(config.pair), tradeParams.mm_liquiditySpreadPercent, targetPrice);
			orderBookInfo.amountTargetPrice *= reliabilityKoef;
			orderBookInfo.amountTargetPriceQuote *= reliabilityKoef;

			priceString = `${config.pair} price of ${targetPrice} ${config.coin2}`;
			if (orderBookInfo.typeTargetPrice === 'inSpread') {
				return {
					msgNotify: '',
					msgSendBack: `${priceString} is already in spread. **No action needed**.\n\n${priceInfoString}`,
					notifyType: 'log'
				}
			} else {
				actionString = `${orderBookInfo.typeTargetPrice} ${orderBookInfo.amountTargetPrice.toFixed(config.coin1Decimals)} ${config.coin1} ${orderBookInfo.typeTargetPrice === 'buy' ? 'with' : 'for'} ${orderBookInfo.amountTargetPriceQuote.toFixed(config.coin2Decimals)} ${config.coin2}`;
			}
	
			if (confirmation) {
				// let order = true;
				let order = await traderapi.placeOrder(orderBookInfo.typeTargetPrice, config.pair, targetPrice, orderBookInfo.amountTargetPrice, 1, orderBookInfo.amountTargetPriceQuote, pairObj);
				if (order) {
					var showRatesAfterOrder = async function (exchangeRatesBefore, priceString, actionString) {
						setTimeout(async () => { 

							priceInfoString = '';
							const exchangeRatesAfter = await traderapi.getRates(pair);
							if (exchangeRatesAfter) {
								priceInfoString += `${config.exchangeName} rates for ${pair} pair:\nBefore action — bid: ${exchangeRatesBefore.bid.toFixed(coin2Decimals)}, ask: ${exchangeRatesBefore.ask.toFixed(coin2Decimals)}.\nAfter action — bid: ${exchangeRatesAfter.bid.toFixed(coin2Decimals)}, ask: ${exchangeRatesAfter.ask.toFixed(coin2Decimals)}.`;
							} else {
								priceInfoString += `Unable to get ${config.exchangeName} rates for ${pair}.`;
							}

							msgNotify = `Making ${priceString}: Successfully placed an order to *${actionString}*.\n\n${priceInfoString}`;
							msgSendBack = `Making ${priceString}: Successfully placed an order to **${actionString}**.\n\n${priceInfoString}`;
							notifyType = 'log';
							notify(msgNotify, notifyType);
							$u.sendAdmMsg(tx.senderId, msgSendBack);

						}, 2000);
					}
					await showRatesAfterOrder(exchangeRatesBefore, priceString, actionString);
				}
	
			} else {
				pendingConfirmation.command = `/make ${params.join(' ')}`;
				pendingConfirmation.timestamp = Date.now();
				msgNotify = '';
				msgSendBack = `Are you sure to make ${priceString}? I am going to **${actionString}**. Confirm with **/y** command or ignore.\n\n${priceInfoString}`;
			}	

		} // if (param === "price")

		return {
			msgNotify,
			msgSendBack,
			notifyType: 'log'
		}

	} catch (e) {
		log.error(`Error in make() of ${$u.getModuleName(module.id)} module: ` + e);
	}
	
}

async function calc(arr) {

	if (arr.length !== 4) {
		return {
			msgNotify: ``,
			msgSendBack: 'Wrong arguments. Command works like this: */calc 2.05 BTC in USDT*.',
			notifyType: 'log'
		}
	}

	let output = '';
	const amount = +arr[0];
	const inCurrency = arr[1].toUpperCase().trim();
	const outCurrency = arr[3].toUpperCase().trim();
	let pair = inCurrency + '/' + outCurrency;
	let pair2 = outCurrency + '/' + inCurrency;

	if (!amount || amount === Infinity) {
		output = `It seems amount "*${amount}*" for *${inCurrency}* is not a number. Command works like this: */calc 2.05 BTC in USDT*.`;
		return {
			msgNotify: ``,
			msgSendBack: `${output}`,
			notifyType: 'log'
		}
	}
	if (!$u.isHasTicker(inCurrency)) {
		output = `I don’t have rates of crypto *${inCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USDT*.`;
	}
	if (!$u.isHasTicker(outCurrency)) {
		output = `I don’t have rates of crypto *${outCurrency}* from Infoservice. Made a typo? Try */calc 2.05 BTC in USDT*.`;
	}

	let result;
	if (!output) {
		result = Store.mathEqual(inCurrency, outCurrency, amount, true).outAmount;
		if (amount <= 0 || result <= 0 || !result) {
			output = `I didn’t understand amount for *${inCurrency}*. Command works like this: */calc 2.05 BTC in USDT*.`;
			return {
				msgNotify: ``,
				msgSendBack: `${output}`,
				notifyType: 'log'
			}
		}
		if ($u.isFiat(outCurrency)) {
			result = +result.toFixed(2);
		}
		output = `Global market value of ${$u.thousandSeparator(amount)} ${inCurrency} equals **${$u.thousandSeparator(result)} ${outCurrency}**.`;
	} else {
		output = '';
	}

	if (output)
		output += "\n\n";
	let askValue, bidValue;

	let exchangeRates = await traderapi.getRates(pair);
	if (exchangeRates) {
		askValue = exchangeRates.ask * amount;
		bidValue = exchangeRates.bid * amount;
		output += `${config.exchangeName} value of ${$u.thousandSeparator(amount)} ${inCurrency}:\nBid: **${$u.thousandSeparator(bidValue.toFixed(8))} ${outCurrency}**, ask: **${$u.thousandSeparator(askValue.toFixed(8))} ${outCurrency}**.`;
	} else {
		exchangeRates = await traderapi.getRates(pair2);
		if (exchangeRates) {
			askValue = amount / exchangeRates.ask;
			bidValue = amount / exchangeRates.bid;
			output += `${config.exchangeName} value of ${$u.thousandSeparator(amount)} ${inCurrency}:\nBid: **${$u.thousandSeparator(bidValue.toFixed(8))} ${outCurrency}**, ask: **${$u.thousandSeparator(askValue.toFixed(8))} ${outCurrency}**.`;
		} else {
			output += `Unable to get ${config.exchangeName} rates for ${pair}.`;
		}
	}

	return {
		msgNotify: ``,
		msgSendBack: `${output}`,
		notifyType: 'log'
	}

}

async function balances() {
	const balances = await traderapi.getBalances();
	let output = '';

	if (balances.length === 0) {
		output = `All empty.`;
	} else {
		balances.forEach(crypto => {
			output += `${$u.thousandSeparator(+crypto.free.toFixed(8), true)} _${crypto.code}_`;
			if (+crypto.freezed > 0) {
				output += ` & ${$u.thousandSeparator(+crypto.freezed.toFixed(8), true)} freezed`;
			}
			output += "\n";
		});
	}

	return {
		msgNotify: ``,
		msgSendBack: `${config.exchangeName} balances:
${output}`,
		notifyType: 'log'
	}

}

function version() {
	return {
		msgNotify: ``,
		msgSendBack: `I am running on _adamant-tradebot_ software version _${Store.version}_. Revise code on ADAMANT's GitHub.`,
		notifyType: 'log'
	}
}

function saveConfig() { 
    const str = "module.exports = " + JSON.stringify(tradeParams, null, 3);
	fs.writeFileSync('./trade/tradeParams_' + config.exchange + '.js', str)
}

const commands = {
	help,
	rates,
	stats,
	orders,
	calc,
	balances,
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
	y
}