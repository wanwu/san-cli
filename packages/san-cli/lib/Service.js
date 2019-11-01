/**
 * @file Service Class
 * @author wangyongqing <wangyongqing01@baidu.com>
 */
const {join, resolve, isAbsolute} = require('path');
const EventEmitter = require('events').EventEmitter;

const fs = require('fs-extra');
const Config = require('webpack-chain');
const webpackMerge = require('webpack-merge');
const cosmiconfig = require('cosmiconfig');
const defaultsDeep = require('lodash.defaultsdeep');
const dotenv = require('dotenv');

const {findExisting} = require('./utils');
const commander = require('./commander');
const SError = require('./SError');
const argsert = require('./argsert');
const PluginAPI = require('./PluginAPI');
const {chalk, debug} = require('./ttyLogger');
const {defaults: defaultConfig, validateSync: validateOptions} = require('./options');

const BUILDIN_PLUGINS = ['base', 'css', 'app', 'optimization', 'babel'];

const logger = debug('Service');
/* global Map, Proxy */
module.exports = class Service extends EventEmitter {
    constructor(cwd, {plugins = [], useBuiltInPlugin = true, projectOptions = {}, cli = commander()} = {}) {
        super();
        this.cwd = cwd || process.cwd();
        this.initialized = false;
        this._initProjectOptions = projectOptions;
        // webpack chain & merge array
        this.webpackChainFns = [];
        this.webpackRawConfigFns = [];
        // 相关的 Map
        // 下面是注册命令 map
        this.registeredCommands = new Map();
        // 下面是注册 command flag map
        this.registeredCommandFlags = new Map();
        this.registeredCommandHandlers = new Map();

        this._cli = cli;
        this.plugins = this.resolvePlugins(plugins, useBuiltInPlugin);
    }
    loadEnv(mode) {
        // this._configDir
        // 1. 优先查找 .san 的文件，
        // 2. 查找到默认的之后，后续查找继续在 .san 查找
        // 3. 后续为：local 内容
        const modeEnvName = `.env${mode ? `.${mode}` : ''}`;
        const envPath = findExisting(this.cwd, [`.san/${modeEnvName}`, modeEnvName]);
        if (!envPath) {
            // 不存在默认的，则不往下执行了
            return;
        }
        const localEnvPath = `${envPath}.local`;

        const load = envPath => {
            try {
                const content = fs.readFileSync(envPath);
                const env = dotenv.parse(content) || {};
                logger('loadEnv', envPath, env);
                return env;
            } catch (err) {
                // only ignore error if file is not found
                if (err.toString().indexOf('ENOENT') < 0) {
                    logger.error('loadEnv', err);
                }
            }
        };

        const localEnv = load(localEnvPath);
        const defaultEnv = load(envPath);

        const envObj = Object.assign(defaultEnv, localEnv);
        Object.keys(envObj).forEach(key => {
            if (!process.env.hasOwnProperty(key)) {
                process.env[key] = envObj[key];
            }
        });

        if (mode) {
            const defaultNodeEnv = mode === 'production' ? mode : 'development';
            // 下面属性如果为空，会根据 mode 设置的
            ['NODE_ENV', 'BABEL_ENV'].forEach(k => {
                if (process.env[k] === null) {
                    process.env[k] = defaultNodeEnv;
                }
            });
        }
    }

    resolvePlugins(plugins = [], useBuiltInPlugin = true) {
        // 0. 判断是否需要加载 builtin plugin
        let builtInPlugins = [];
        if (useBuiltInPlugin) {
            builtInPlugins = BUILDIN_PLUGINS.map(id => require(`../configs/${id}`));
        }
        plugins = Array.isArray(plugins) ? plugins : [];

        if (plugins.length) {
            // 2. 真正加载
            plugins = plugins.map(this._resolvePlugin);
            plugins = [...builtInPlugins, ...plugins];
        } else {
            plugins = builtInPlugins;
        }

        return plugins;
    }
    _resolvePlugin(p) {
        let pluginOptions;
        if (Array.isArray(p) && p.length === 2) {
            // 带有参数的plugin 配置
            pluginOptions = p[1];
            p = p[0];
        }
        if (typeof p === 'string') {
            // 处理引入
            try {
                let plugin = require(p);
                if (plugin.default) {
                    // 重新赋值 esmodule
                    plugin = plugin.default;
                }
                if (typeof plugin === 'object' && typeof plugin.apply === 'function') {
                    if (!plugin.id) {
                        // 默认 id 是配置的string，方便查找
                        plugin.id = p;
                    }
                    // 这里支持两种情况：
                    // 1. 普通 plugin，没有参数
                    // 2. plugin 是 array，则第二个 value 是 options
                    // 这样兼容同一个 plugin 多次调用 options 不同情况
                    if (pluginOptions) {
                        return [plugin, pluginOptions];
                    }
                    return plugin;
                } else {
                    throw new SError('Plugin is valid : ' + p);
                }
            } catch (e) {
                throw new SError('Require plugin is valid : ' + p);
            }
        } else if (typeof p === 'object' && p.id && typeof p.apply === 'function') {
            // 处理 object
            return p;
        } else {
            // 写明白这里是需要 id 的
            throw new SError('Plugin is valid : ' + p);
        }
    }
    init(mode) {
        if (this.initialized) {
            // 初始化过一次之后就不需要二次了
            // 注意这里会导致 configFile 这类二次修改不会生效
            return this;
        }
        this.initialized = true;
        this.mode = mode;

        this.plugins.forEach(plugin => {
            this.initPlugin(plugin);
        });
        // apply webpack configs from project config file
        if (this.projectOptions.chainWebpack) {
            this.webpackChainFns.push(this.projectOptions.chainWebpack);
        }
        if (this.projectOptions.configureWebpack) {
            this.webpackRawConfigFns.push(this.projectOptions.configureWebpack);
        }
        return this;
    }
    initPlugin(plugin) {
        let options = {};
        if (Array.isArray(plugin)) {
            options = plugin[1];
            plugin = plugin[0];
        }
        const {id, apply} = plugin;
        const self = this;
        const api = new Proxy(new PluginAPI(id, this), {
            get(target, prop) {
                // 传入配置的自定义 pluginAPI 方法

                if (
                    [
                        'registerCommand',
                        'version',
                        'on',
                        'emit',
                        'registerCommandFlag',
                        'addPlugin',
                        'resolveChainableWebpackConfig',
                        'resolveWebpackConfig'
                    ].includes(prop)
                ) {
                    if (typeof self[prop] === 'function') {
                        return self[prop].bind(self);
                    } else {
                        return self[prop];
                    }
                } else if (['getCwd', 'getProjectOptions', 'getVersion'].includes(prop)) {
                    // 将属性转换成 getXXX 模式
                    prop = prop.replace(/^get([A-Z])/, (m, $1) => $1.toLowerCase());
                    return () => self[prop];
                } else {
                    return target[prop];
                }
            }
        });
        // 传入配置的 options
        // 因为一般 plugin 不需要自定义 options，所以 projectOption 作为第二个参数
        apply(api, this.projectOptions, options);
        return this;
    }
    registerCommandFlag(cmdName, flag, handler) {
        argsert('<string> <object> <function>', [cmdName, flag, handler], arguments.length);
        cmdName = getCommandName(cmdName);
        const flagMap = this.registeredCommandFlags;
        let flags = flagMap.get(cmdName) || {};
        flags = Object.assign(flags, flag);
        flagMap.set(cmdName, flags);
        const handlerMap = this.registeredCommandHandlers;
        const handlers = handlerMap.get(cmdName) || [];
        handlers.push(handler);
        handlerMap.set(cmdName, handlers);
        return this;
    }
    registerCommand(name, yargsModule) {
        argsert('<string|<object> [function|object]', [name, yargsModule], arguments.length);
        /* eslint-disable one-var */
        let command, description, builder, handler, middlewares;
        /* eslint-enable one-var */
        if (typeof name === 'object') {
            command = name.command;
            description = name.description || name.desc;
            builder = name.builder;
            handler = name.handler;
            middlewares = name.middlewares;
        } else {
            command = name;
            if (typeof yargsModule === 'function') {
                handler = yargsModule;
            } else {
                description = yargsModule.description || yargsModule.desc;
                builder = yargsModule.builder;
                handler = yargsModule.handler;
                middlewares = yargsModule.middlewares;
            }
        }

        if (typeof handler !== 'function') {
            handler = argv => {
                logger.warn('registerCommand', `${name} has an empty handler.`);
            };
        }
        // 绑定 run，实际是通过 run 之后执行的
        const cmdName = getCommandName(command);
        this.registeredCommands.set(cmdName, {
            command,
            handler,
            description: description ? description : false,
            builder: builder ? builder : {},
            middlewares: middlewares ? middlewares : []
        });
        return this;
    }
    _registerCommand(command, handler, description, builder, middlewares) {
        argsert(
            '<string> <function> [string|boolean] [object|function] [array]',
            [command, handler, description, builder, middlewares],
            arguments.length
        );
        this._cli.command(command, description, builder, handler, middlewares);
        return this;
    }
    async loadProjectOptions(configFile) {
        let originalConfigFile = configFile;
        if (configFile && typeof configFile === 'string') {
            configFile = isAbsolute(configFile) ? configFile : resolve(this.cwd, configFile);
            if (!fs.existsSync(configFile)) {
                configFile = false;
                logger.warn('config-file', `${originalConfigFile} is not exists!`);
            }
        }
        // 首先试用 argv 的 config，然后寻找默认的，找到则读取，格式失败则报错
        let config = defaultsDeep(this._initProjectOptions, defaultConfig);
        let result = {
            filepath: originalConfigFile,
            config: configFile ? require(configFile) : false
        };
        if (!configFile) {
            // 使用 cosmiconfig 查找
            const explorer = cosmiconfig('san', {
                // 寻找.san文件夹优先于 cwd
                searchPlaces: ['.san/config.js', 'san.config.js']
            });
            result = explorer.searchSync(this.cwd) || {};
        }

        if (result && result.config) {
            let configPath = result.filepath;

            if (!result.config || typeof result.config !== 'object') {
                logger.error('loadProjectOptions', `${chalk.bold(configPath)}: 格式必须是对象.`);
            } else {
                // 校验config.js schema 格式
                try {
                    await validateOptions(result.config);
                } catch (e) {
                    console.log(e);
                    logger.error('loadProjectOptions', `${chalk.bold(configPath)}: 格式不正确.`);
                    throw new SError(e);
                }
            }

            // 加载默认的 config 配置
            config = defaultsDeep(result.config, config);
        } else {
            logger.warn('loadProjectOptions', `${chalk.bold('san.config.js')} Cannot find! Use default config.`);
        }
        const searchFor = resolve(this.cwd, '.');
        // 1. 加载 postcss 配置
        if (!(config.css && config.css.postcss)) {
            // 赋值给 css 配置
            const postcss = (cosmiconfig('postcss').searchSync(searchFor) || {}).config;

            config.css = Object.assign(
                {
                    postcss
                },
                config.css || {}
            );
        }

        if (!config.browserslist) {
            // 2. 加载 browserslist 配置
            const browserslist = (cosmiconfig('browserslist').searchSync(searchFor) || {}).config;
            // 赋值给 config 的 browserslist
            config.browserslist = browserslist || [
                '> 1.2% in cn',
                'last 2 versions',
                'iOS >=8', // 这里有待商榷
                'android>4.4',
                'not bb>0',
                'not ff>0',
                'not ie>0',
                'not ie_mob>0'
            ];
        }

        // normalize publicPath
        ensureSlash(config, 'publicPath');
        if (typeof config.publicPath === 'string') {
            config.publicPath = config.publicPath.replace(/^\.\//, '');
        }
        removeSlash(config, 'outputDir');
        return config;
    }
    runCommand(cmd, rawArgs) {
        // 组装 command，然后解析执行
        // 0. registerCommand 和 registerCommandFlag 记录 command
        let handlers = this.registeredCommandHandlers.get(cmd);
        let flags = this.registeredCommandFlags.get(cmd) || {};
        /* eslint-disable fecs-camelcase */
        const _command = this.registeredCommands.get(cmd);
        /* eslint-enable fecs-camelcase */
        if (!_command) {
            // 命令不存在哦~
            logger.error('runCommand', `${this._cli.$0} ${cmd} is not exist!`);
            return this;
        }
        /* eslint-disable fecs-camelcase */
        const {command, handler: oHandler, description, builder: oFlags, middlewares} = _command;
        /* eslint-enable fecs-camelcase */
        // 0.1 处理 flags
        const builder = Object.assign(flags, oFlags || {});
        // 0.2 处理 handler
        const handler = argv => {
            if (!Array.isArray(handlers) && typeof handlers === 'function') {
                handlers = [handlers];
            }
            let doit = true;
            if (Array.isArray(handlers)) {
                for (let i = 0, len = handlers.length; i < len; i++) {
                    const handler = handlers[i];
                    if (typeof handler === 'function') {
                        doit = handler(argv);
                        // ！！！返回 false 则则停止后续操作！！！
                        if (doit === false) {
                            // 跳出循环
                            break;
                        }
                    }
                }
            }
            // waring：
            // 如果任何注入的命令 flag handler 返回为 false，则会停止后续命令执行
            // 所以这里不一定会执行，看 doit 的结果
            // 最后执行，因为插入的 flags 都是前置的函数，
            // 而注册 command 的 handler 才是主菜
            doit !== false && oHandler(argv);
        };
        // 1. cli 添加命令
        this._registerCommand(command, handler, description, builder, middlewares);
        // 2. cli.parse 解析
        if (rawArgs[0] !== cmd) {
            rawArgs.unshift(cmd);
        }
        this._cli.help().parse(rawArgs || process.argv.slice(2));
        return this;
    }

    async run(cmd, argv = {}, rawArgv = process.argv.slice(2)) {
        // eslint-disable-next-line
        let {_version: version, _logger: logger} = argv;
        // 保证 Api.getxx 能够获取
        this.version = version;
        this.logger = logger;

        const mode = argv.mode || (cmd === 'build' && argv.watch ? 'development' : 'production');
        this.loadEnv(mode);

        // set mode
        // load user config
        const projectOptions = await this.loadProjectOptions(argv.configFile);
        const logInfo = logger('run:options');
        logInfo(projectOptions);

        this.projectOptions = projectOptions;

        // 开始添加依赖 argv 的内置 plugin
        // 添加progress plugin
        if (!argv.noProgress) {
            this.addPlugin('../plugins/progress');
        }
        this.init(mode);
        this.runCommand(cmd, rawArgv);
        return this;
    }
    addPlugin(name, options = {}) {
        const plugin = this._resolvePlugin([name, options]);
        this.plugins.push(plugin);
        return this;
    }

    resolveChainableWebpackConfig() {
        const chainableConfig = new Config();
        // apply chains
        this.webpackChainFns.forEach(fn => fn(chainableConfig));
        return chainableConfig;
    }

    resolveWebpackConfig(chainableConfig = this.resolveChainableWebpackConfig()) {
        if (!this.initialized) {
            throw new SError('Service must call init() before calling resolveWebpackConfig().');
        }
        // get raw config
        let config = chainableConfig.toConfig();
        const original = config;
        // apply raw config fns
        this.webpackRawConfigFns.forEach(fn => {
            if (typeof fn === 'function') {
                // function with optional return value
                const res = fn(config);
                if (res) {
                    config = webpackMerge(config, res);
                }
            } else if (fn) {
                // merge literal values
                config = webpackMerge(config, fn);
            }
        });

        // #2206 If config is merged by merge-webpack, it discards the __ruleNames
        // information injected by webpack-chain. Restore the info so that
        // vue inspect works properly. (hulk inspect)
        if (config !== original) {
            cloneRuleNames(config.module && config.module.rules, original.module && original.module.rules);
        }

        return config;
    }
};

function cloneRuleNames(to, from) {
    if (!to || !from) {
        return;
    }
    from.forEach((r, i) => {
        if (to[i]) {
            Object.defineProperty(to[i], '__ruleNames', {
                value: r.__ruleNames
            });
            cloneRuleNames(to[i].oneOf, r.oneOf);
        }
    });
}

function removeSlash(config, key) {
    if (typeof config[key] === 'string') {
        config[key] = config[key].replace(/\/$/g, '');
    }
}
function ensureSlash(config, key) {
    let val = config[key];
    if (typeof val === 'string') {
        if (!/^https?:/.test(val)) {
            val = val.replace(/^([^/.])/, '/$1');
        }
        config[key] = val.replace(/([^/])$/, '$1/');
    }
}

function getCommandName(command) {
    return command
        .replace(/\s{2,}/g, ' ')
        .split(/\s+(?![^[]*]|[^<]*>)/)[0]
        .trim();
}
