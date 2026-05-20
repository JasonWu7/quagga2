/**
 * BarcodeScanner - 条码扫码器封装库
 * 依赖 Quagga2
 * 使用方法：
 *   BarcodeScanner.scan().then(barcode => {
 *       console.log('扫描结果:', barcode);
 *       // 将结果填入表单字段等...
 *   }).catch(err => {
 *       console.error('扫描取消或失败:', err);
 *   });
 *
 *   // 高级选项
 *   BarcodeScanner.scan({
 *       autoConfirm: true,      // 稳定识别后自动返回，无需点确认
 *       timeout: 30000,         // 30秒无操作自动取消
 *       facingMode: "environment",
 *       quaggaConfig: {         // 自定义 Quagga 配置（深度合并）
 *           frequency: 5,
 *           numOfWorkers: 2,
 *           decoder: { readers: ['ean_reader'] }
 *       }
 *   }).then(...).catch(...);
 */
(function (global) {
    'use strict';

    // 当前活动的扫描器实例（单例）
    let activeScanner = null;

    // Quagga 地址
    // const QUAGGA_CDN = '../commons/js/quagga.min.js';
    const QUAGGA_CDN = './quagga.min.js';

    // 方便测试
    // const QUAGGA_CDN = 'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.12.1/dist/quagga.min.js';

    // 确保 Quagga 已加载
    function loadQuagga() {
        if (global.Quagga) {
            return Promise.resolve(global.Quagga);
        }
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = QUAGGA_CDN;
            script.onload = () => resolve(global.Quagga);
            script.onerror = () => reject(new Error('Quagga 加载失败，请检查网络'));
            document.head.appendChild(script);
        });
    }

    // 移除 DOM 元素
    function removeElement(el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    // 深度合并对象（不修改原对象）
    function deepMerge(target, source) {
        if (!source) return target;
        const output = Array.isArray(target) ? target.slice() : Object.assign({}, target);
        for (let key in source) {
            if (source.hasOwnProperty(key)) {
                const sourceVal = source[key];
                const targetVal = output[key];
                if (typeof sourceVal === 'object' && sourceVal !== null && !Array.isArray(sourceVal)) {
                    output[key] = deepMerge(targetVal, sourceVal);
                } else {
                    output[key] = sourceVal;
                }
            }
        }
        return output;
    }

    // 扫描器类（内部使用）
    class ScannerSession {
        constructor(options) {
            this.options = Object.assign({
                autoConfirm: false,
                timeout: 0,
                facingMode: 'environment',
                readerTypes: ['code_128_reader', 'ean_reader', 'ean_8_reader', 'code_39_reader', 'upc_reader'],
                quaggaConfig: {}   // 外部可传入的自定义配置
            }, options);
            this.container = null;
            this.resultDisplay = null;
            this.confirmBtn = null;
            this.clearBtn = null;
            this.closeBtn = null;
            this.scanResultBuffer = [];
            this.lastScanTime = 0;
            this.currentDisplayCode = '';
            this.isActive = true;
            this.timeoutId = null;
            this.deferred = null;      // { resolve, reject }
            this.cleanupDone = false;
        }

        // 创建 UI 界面
        buildUI() {
            const div = document.createElement('div');
            div.id = 'barcode-scanner-overlay';
            div.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: #000;
                z-index: 9999;
            `;

            // 结果显示区域
            const resultDisplay = document.createElement('div');
            resultDisplay.id = 'scanResultDisplay';
            resultDisplay.textContent = '正在扫描...';
            resultDisplay.style.cssText = `
                position: absolute;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                color: #fff;
                font-size: 18px;
                font-weight: bold;
                z-index: 10000;
                padding: 10px 20px;
                background: rgba(0,0,0,0.7);
                border-radius: 5px;
                white-space: nowrap;
            `;
            div.appendChild(resultDisplay);
            this.resultDisplay = resultDisplay;

            // 确认按钮（手动模式）
            if (!this.options.autoConfirm) {
                const confirmBtn = document.createElement('button');
                confirmBtn.textContent = '确认';
                confirmBtn.style.cssText = `
                    position: absolute;
                    bottom: 80px;
                    left: 50%;
                    transform: translateX(-50%);
                    z-index: 10000;
                    padding: 12px 40px;
                    font-size: 16px;
                    background: #52c41a;
                    color: #fff;
                    border: none;
                    border-radius: 5px;
                    display: none;
                `;
                confirmBtn.onclick = () => this.confirmHandler();
                div.appendChild(confirmBtn);
                this.confirmBtn = confirmBtn;

                // 清除按钮（仅手动模式保留）
                const clearBtn = document.createElement('button');
                clearBtn.textContent = '清除';
                clearBtn.style.cssText = `
                    position: absolute;
                    bottom: 20px;
                    right: 20px;
                    z-index: 10000;
                    padding: 10px 30px;
                    font-size: 14px;
                    background: #faad14;
                    color: #fff;
                    border: none;
                    border-radius: 5px;
                `;
                clearBtn.onclick = () => this.clearHandler();
                div.appendChild(clearBtn);
                this.clearBtn = clearBtn;
            }

            // 关闭按钮（两种模式都有）
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '关闭';
            closeBtn.style.cssText = `
                position: absolute;
                bottom: 20px;
                left: 20px;
                z-index: 10000;
                padding: 10px 30px;
                font-size: 14px;
                background: #f5222d;
                color: #fff;
                border: none;
                border-radius: 5px;
            `;
            closeBtn.onclick = () => this.cancelHandler('cancel');
            div.appendChild(closeBtn);
            this.closeBtn = closeBtn;

            document.body.appendChild(div);
            this.container = div;
        }

        // 初始化 Quagga（支持自定义配置深度合并）
        initScanner() {
            return new Promise((resolve, reject) => {
                // 基础配置
                const baseConfig = {
                    inputStream: {
                        name: 'Live',
                        type: 'LiveStream',
                        target: this.container,
                        constraints: {
                            facingMode: this.options.facingMode,
                            width: { min: 640, max: 1280 },
                            height: { min: 480, max: 720 }
                        }
                    },
                    decoder: { readers: this.options.readerTypes },
                    locate: true,
                    numOfWorkers: navigator.hardwareConcurrency || 4,
                    frequency: 10
                };

                // 深度合并外部自定义配置（外部可覆盖任意字段）
                const finalConfig = deepMerge(baseConfig, this.options.quaggaConfig);

                Quagga.init(finalConfig, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        Quagga.start();
                        Quagga.onDetected((result) => this.onDetected(result));
                        resolve();
                    }
                });
            });
        }

        // 扫描结果处理（带缓冲稳定逻辑）
        onDetected(result) {
            if (!this.isActive) return;
            const code = result.codeResult.code;
            const now = Date.now();
            if (now - this.lastScanTime < 200) return;
            this.lastScanTime = now;

            this.scanResultBuffer.push(code);
            if (this.scanResultBuffer.length > 5) this.scanResultBuffer.shift();

            const counts = {};
            this.scanResultBuffer.forEach(c => { counts[c] = (counts[c] || 0) + 1; });
            let maxCount = 0, stableCode = '';
            for (let c in counts) {
                if (counts[c] > maxCount) {
                    maxCount = counts[c];
                    stableCode = c;
                }
            }

            if (maxCount >= 3 && stableCode === code) {
                this.currentDisplayCode = stableCode;
                this.resultDisplay.textContent = stableCode;
                this.resultDisplay.style.color = '#52c41a';
                if (this.options.autoConfirm) {
                    // 自动确认模式：稳定后直接返回结果
                    this.complete(stableCode);
                } else if (this.confirmBtn) {
                    this.confirmBtn.style.display = 'block';
                }
            } else {
                this.resultDisplay.textContent = code;
                this.resultDisplay.style.color = '#fff';
                if (!this.options.autoConfirm && this.confirmBtn) {
                    this.confirmBtn.style.display = 'none';
                }
            }
        }

        // 点击确认
        confirmHandler() {
            if (this.currentDisplayCode) {
                this.complete(this.currentDisplayCode);
            } else {
                // 没有稳定条码时提示
                this.resultDisplay.textContent = '未识别到稳定条码，请继续扫描';
                this.resultDisplay.style.color = '#ff4d4f';
                setTimeout(() => {
                    if (this.isActive && this.resultDisplay) {
                        this.resultDisplay.textContent = this.currentDisplayCode || '正在扫描...';
                        this.resultDisplay.style.color = this.currentDisplayCode ? '#52c41a' : '#fff';
                    }
                }, 1000);
            }
        }

        // 清除缓冲区
        clearHandler() {
            this.scanResultBuffer = [];
            this.currentDisplayCode = '';
            this.resultDisplay.textContent = '正在扫描...';
            this.resultDisplay.style.color = '#fff';
            if (this.confirmBtn) this.confirmBtn.style.display = 'none';
        }

        // 取消扫描（关闭按钮或超时）
        cancelHandler(reason = 'cancel') {
            if (!this.isActive) return;
            this.cleanup();
            if (this.deferred) this.deferred.reject(new Error(reason));
        }

        // 成功完成扫描
        complete(barcode) {
            if (!this.isActive) return;
            this.cleanup();
            if (this.deferred) this.deferred.resolve(barcode);
        }

        // 清理资源
        cleanup() {
            if (this.cleanupDone) return;
            this.cleanupDone = true;
            this.isActive = false;

            if (this.timeoutId) clearTimeout(this.timeoutId);
            if (Quagga) {
                try {
                    Quagga.stop();
                    Quagga.offDetected();
                } catch(e) {}
            }
            removeElement(this.container);
            this.container = null;
            this.resultDisplay = null;
            this.confirmBtn = null;
            this.clearBtn = null;
            this.closeBtn = null;
            activeScanner = null;
        }

        // 启动扫描会话，返回 Promise
        start() {
            return new Promise((resolve, reject) => {
                this.deferred = { resolve, reject };
                this.buildUI();
                this.initScanner().then(() => {
                    if (this.options.timeout > 0) {
                        this.timeoutId = setTimeout(() => {
                            if (this.isActive) this.cancelHandler('timeout');
                        }, this.options.timeout);
                    }
                }).catch(err => {
                    this.cleanup();
                    reject(new Error('摄像头启动失败: ' + err));
                });
            });
        }
    }

    // 对外暴露的扫描接口
    function scan(options = {}) {
        // 如果已有活动扫描器，先取消旧会话并 reject
        if (activeScanner) {
            activeScanner.cancelHandler('interrupt');
            activeScanner = null;
        }

        return loadQuagga().then(() => {
            const session = new ScannerSession(options);
            activeScanner = session;
            return session.start();
        }).catch(err => {
            // 确保清理全局标记
            if (activeScanner) {
                activeScanner.cleanup();
                activeScanner = null;
            }
            throw err;
        });
    }

    // 主动停止当前扫描（若有）
    function stop() {
        if (activeScanner) {
            activeScanner.cancelHandler('manual_stop');
            activeScanner = null;
        }
    }

    // 检查是否支持（由 Quagga 特性决定）
    function isSupported() {
        return !!(global.navigator && global.navigator.mediaDevices && global.navigator.mediaDevices.getUserMedia);
    }

    // 暴露全局对象
    const BarcodeScanner = {
        scan,
        stop,
        isSupported
    };

    // 支持 CommonJS / AMD / 全局
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = BarcodeScanner;
    } else if (typeof define === 'function' && define.amd) {
        define([], function() { return BarcodeScanner; });
    } else {
        global.BarcodeScanner = BarcodeScanner;
    }

})(window);