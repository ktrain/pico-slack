const request = require('superagent');
const _ = require('lodash');
const path = require('path');
const WebSocket = require('ws');
const Events = require('events');

const processTeamData = (teamData)=>{
	Slack.bot.id = teamData.self.id;
	_.each(teamData.channels, (channel)=>{ Slack.channels[channel.id] = channel.name; });
	_.each(teamData.groups,   (channel)=>{ Slack.channels[channel.id] = channel.name; });
	_.each(teamData.users,    (user)   =>{
		Slack.users[user.id] = user.name;
		if(user.profile && user.profile.bot_id) Slack.bots[user.profile.bot_id] = user.id;
	});
	_.each(teamData.ims,(im)=>{ Slack.dms[im.id] = Slack.users[im.user]});
};

const processIncomingEvent = (msg)=>{
	const res = _.assign({}, msg);
	res.text = res.text || "";
	res.channel_id = msg.channel;
	res.user_id = msg.user;
	if(msg.bot_id) res.user_id = Slack.bots[msg.bot_id];

	//For reactions
	if(msg.item && msg.item.channel) res.channel_id = msg.item.channel;

	if(res.channel_id) res.channel = Slack.channels[res.channel_id];
	if(res.user_id) res.user = Slack.users[res.user_id];
	if(msg.username) res.user = msg.username;
	if(res.channel_id && res.channel_id[0] == 'D'){
		res.isDirect = true;
		res.channel = res.channel_id;
	}
	return res;
};
const log = (color, ...args)=>{
	const text = _.map(args, (arg)=>{
		if(arg instanceof Error) return arg.toString();
		return JSON.stringify(arg, null, '  ')
	})
	console.log(...text);
	if(!Slack.connected) return;
	Error.prepareStackTrace = (err, stack)=>stack;
	const err = _.find(args, (arg) =>arg instanceof Error);
	const caller = err ? err.stack[0] : (new Error()).stack[1];
	const fileName = caller.getFileName ? path.relative(process.cwd(), caller.getFileName()) : '???';
	const lineNumber = caller.getLineNumber ? caller.getLineNumber() : '???'
	return Slack.api('chat.postMessage', {
		channel    : Slack.log_channel,
		username   : Slack.bot.name,
		icon_emoji : Slack.bot.icon,
		attachments: JSON.stringify([{
			color     : color,
			text      : '```' + text.join(', ') + '```',
			mrkdwn_in : ['text'],
			footer : `${fileName}:${lineNumber}`
		}])
	}).catch(()=>{})
};

const Slack = {
	connected : false,
	token : '',
	socket : null,
	log_channel : 'diagnostics',
	channels : {},
	users    : {},
	bots     : {},
	dms      : {},
	bot : {
		id : '',
		name : 'bot',
		icon : ':robot_face:'
	},
	setInfo : (name, icon)=>{
		Slack.bot.name = name;
		Slack.bot.icon = `:${_.replace(icon, /:/g, '')}:`
	},
	connect : (token)=>{
		Slack.token = token;
		return Slack.api('rtm.start')
			.then((data) => {
				return new Promise((resolve, reject)=>{
					if (!data.ok || !data.url) return reject(`bad access token`);
					processTeamData(data);
					Slack.socket = new WebSocket(data.url);

					Slack.socket.on('open', resolve);
					Slack.socket.on('message', (rawData, flags) => {
						try{
							const message = processIncomingEvent(JSON.parse(rawData));
							if(message.user_id === Slack.bot.id) return;
							Slack.emitter.emit(message.type, message);
						}catch(err){ Slack.error(err); }
					});
				});
			})
			.then(()=>Slack.connected = true)
	},
	close : ()=>new Promise((resolve, reject)=>Slack.socket.close(()=>resolve())),
	api : (command, payload) => {
		return new Promise((resolve, reject)=>{
			request
				.get(`https://slack.com/api/${command}`)
				.query(_.assign({ token : Slack.token }, payload))
				.end((err, res)=>{
					if(err || (res.body && res.body.ok === false)) return reject(err || res.body.error);
					return resolve(res.body);
				});
		});
	},
	send : (target, text, opts)=>{
		target = target.channel_id || target
		const directMsg = _.findKey(Slack.dms, (user)=>target == user);
		return Slack.api('chat.postMessage', _.assign({
			channel    : (directMsg || target),
			text       : text,
			username   : Slack.bot.name,
			icon_emoji : Slack.bot.icon
		}, opts))
	},
	sendAs : (botname, boticon, target, text)=>Slack.msg(target, text, {username: botname, icon_emoji:`:${_.replace(boticon, /:/g, '')}:`}),
	react : (msg, emoji)=>{
		return Slack.api('reactions.add', {
			channel   : msg.channel_id || msg.channel,
			name      : _.replace(emoji, /:/g, ''),
			timestamp : msg.ts
		});
	},

	emitter : new Events(),
	onMessage : (handler)=>Slack.emitter.on('message', handler),
	onReact : (handler)=>Slack.emitter.on('reaction_added', handler),

	log   : log.bind(null, ''),
	debug : log.bind(null, '#3498db'),
	info  : log.bind(null, 'good'),
	warn  : log.bind(null, 'warning'),
	error : log.bind(null, 'danger'),

	//Utils
	msgHas : (msg, ...filters)=>{
		if(!msg) return false;
		if(msg.text) msg = msg.text;
		if(!_.isString(msg)) return false;
		msg = msg.toLowerCase();
		return _.every(filters, (opts)=>{
			if(_.isString(opts)) opts = [opts];
			return _.some(opts, (opt)=>msg.indexOf(opt.toLowerCase()) !== -1)
		});
	},
};

//Aliases
Slack.msg   = Slack.send;
Slack.msgAs = Slack.sendAs;


module.exports = Slack;
