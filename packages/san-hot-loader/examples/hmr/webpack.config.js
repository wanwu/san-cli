/**
 * @file webpack.config.js
 * @author tanglei02 (tanglei02@baidu.com)
 */

const webpack = require('webpack');
const HTMLWebpackPlugin = require('html-webpack-plugin');
const path = require('path');

module.exports = {
    entry: path.resolve(__dirname, './src/index.js'),
    output: {
        filename: 'bundle.js',
        path: path.resolve(__dirname, 'dist')
    },
    devtool: 'inline-source-map',
    mode: 'development',
    module: {
        rules: [
            {
                test: /\.js$/,
                use: [
                    {
                        loader: path.resolve(__dirname, '../../index'),
                        options: {
                            component: {
                                patterns: [
                                    {
                                        component: /\.san\.js$/
                                    },
                                    {
                                        component: 'auto'
                                    }
                                ]
                            },
                            store: {
                                patterns: [
                                    {
                                        store: /\.store\.js$/,
                                        getAction: function (storePath) {
                                            return path.resolve(storePath, '../custom-store-actions.js');
                                        }
                                    },
                                    {
                                        store: 'auto',
                                        action: 'auto'
                                    }
                                ]
                            }
                        }
                    },
                    {
                        loader: 'babel-loader',
                        options: {
                            plugins: [
                                require.resolve('@babel/plugin-proposal-class-properties')
                            ]
                        }
                    }
                ]
            }
        ]
    },
    devServer: {
        contentBase: path.resolve(__dirname, 'dist'),
        overlay: true,
        hot: true,
        inline: true
    },
    plugins: [
        new HTMLWebpackPlugin({
            template: path.resolve(__dirname, './index.html')
        }),
        new webpack.NamedModulesPlugin(),
        new webpack.HotModuleReplacementPlugin()
    ]
};

