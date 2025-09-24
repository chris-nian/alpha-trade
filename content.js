class BinanceAutoTrader {
    constructor() {
        this.isRunning = false;
        this.currentAmount = 0;
        // 安全缓冲：为避免因手续费/价格波动/步长舍入导致实付超出目标，预留下调比例
        this.buyAmountSafetyBuffer = 0.002; // 0.2%
        this.ui = null;
        this.logContainer = null;
        this.statusDisplay = null;
        this.tradeCounter = null;
        this.currentState = 'idle'; // idle, buying, monitoring_buy, selling, monitoring_sell
        this.orderCheckInterval = null;
        this.dragOffset = { x: 0, y: 0 };
        
        // 作用域与安全点击
        this.orderRoot = null; // 交易面板根节点
        
        // 交易次数控制
        this.maxTradeCount = 0; // 最大交易次数，0表示无限制
        this.currentTradeCount = 0; // 当前交易次数
        
        // 每日统计
        this.dailyTradeCount = 0; // 今日交易次数
        this.lastTradeDate = null; // 上次交易日期
        
        // 配置参数
        this.tradeDelay = 2; // 每笔买入的延迟时间(秒)
        this.countdownInterval = null; // 倒计时定时器
        
        // 智能交易配置
        this.smartTradingMode = false; // 是否启用智能交易模式
        this.autoBuyFromFallToFlat = true; // 从下降进入平缓期买入
        this.autoBuyFromFlatToRise = true; // 从平缓/下降进入上涨期买入
        this.autoStopFromFlatToFall = true; // 从平缓进入下降时停止
        this.autoStopFromRiseToFlat = true; // 从上涨进入平缓时停止
        
        // 趋势分析
        this.trendData = []; // 存储20条趋势数据
        this.maxTrendDataCount = 20; // 最大存储条数
        this.currentTrend = 'unknown'; // 当前趋势：rising, falling, flat, unknown
        this.previousTrend = 'unknown'; // 前一个趋势
        this.trendAnalysisInterval = null; // 趋势分析定时器
        
        // 连续信号判断
        this.consecutiveFlatSignals = 0; // 连续平缓信号计数
        this.requiredConsecutiveFlat = 3; // 需要连续3次平缓信号

        // 智能交易买入比例
        this.buyAmountRatio = 1.0; // 默认买入100%金额

        // 卖出折价率
        this.sellDiscountRate = 0.02; // 默认2%折价率

        // 下降信号等待机制
        this.lastFallingSignalIndex = -1; // 最后一次下降信号在trendData中的索引
        this.fallingSignalWaitCount = 10; // 下降信号后需要等待的信号数量
        this.canStartBuying = true; // 是否可以开始买入

        // 强制停止标志
        this.forceStop = false; // 强制停止所有交易

        // 智能交易执行标志
        this.isSmartTradingExecution = false; // 当前是否在智能交易执行中

        // 当前会话模式：idle、manual、smart
        this.sessionMode = 'idle';
        // 弹窗确认互斥锁，防止重复点击导致多弹窗
        this.confirmationInProgress = false;
        
        // 弹窗处理状态跟踪
        this.lastModalProcessTime = 0;
        this.modalProcessingDelay = 2000; // 弹窗处理后的强制等待时间（毫秒）
        
        // DOM元素缓存
        this.cachedElements = {
            buyTab: null,
            sellTab: null,
            buyButton: null,
            sellButton: null,
            totalInput: null,
            confirmButton: null,
            lastCacheTime: 0
        };
        
        this.init();
    }

    // DOM元素缓存和获取方法
    getCachedElement(key, selector, refresh = false) {
        const now = Date.now();
        const cacheExpiry = 5000; // 5秒缓存过期
        
        if (refresh || !this.cachedElements[key] || (now - this.cachedElements.lastCacheTime) > cacheExpiry) {
            this.cachedElements[key] = document.querySelector(selector);
            this.cachedElements.lastCacheTime = now;
        }
        
        return this.cachedElements[key];
    }

    clearElementCache() {
        Object.keys(this.cachedElements).forEach(key => {
            if (key !== 'lastCacheTime') {
                this.cachedElements[key] = null;
            }
        });
        this.orderRoot = null;
    }

    init() {
        this.createUI();
        this.setupMessageListener();
        this.log('插件已加载', 'info');
    }

    createUI() {
        this.ui = document.createElement('div');
        this.ui.id = 'binance-auto-trader';
        this.ui.innerHTML = `
            <div class="header">
                <div class="title">币安Alpha自动买入</div>
                <div class="header-buttons">
                    <button class="config-btn" id="config-btn" title="配置">⚙️</button>
                <button class="minimize-btn" id="minimize-btn">—</button>
                </div>
            </div>
            <div class="config-panel" id="config-panel" style="display: none;">
                <div class="config-title">配置设置</div>
                <div class="config-row">
                    <label for="config-delay">延迟时间 (秒):</label>
                    <input type="number" id="config-delay" step="0.5" min="0" value="2">
                </div>
                <div class="config-row">
                    <label for="config-sell-discount">卖出折价率 (%):</label>
                    <input type="number" id="config-sell-discount" step="0.1" min="0" max="10" value="2">
                </div>
                <div class="config-section">
                    <div class="config-section-title">智能交易策略</div>
                    <div class="config-info">
                        <div class="config-info-item">
                            <span class="config-info-label">买入条件：</span>
                            <span class="config-info-text">最近3个信号：[平缓, 平缓, 平缓/上涨] → 买入50%金额</span>
                        </div>
                        <div class="config-info-item">
                            <span class="config-info-label">买入条件：</span>
                            <span class="config-info-text">最近3个信号：[平缓/上涨, 上涨, 上涨] → 买入100%金额</span>
                        </div>
                        <div class="config-info-item">
                            <span class="config-info-label">停止条件：</span>
                            <span class="config-info-text">出现下降信号 → 立即停止</span>
                        </div>
                        <div class="config-info-item">
                            <span class="config-info-label">等待机制：</span>
                            <span class="config-info-text">下降信号后需等待10个信号才能重新买入</span>
                        </div>
                    </div>
                </div>
                <div class="config-buttons">
                    <button class="config-save-btn" id="config-save-btn">保存</button>
                    <button class="config-cancel-btn" id="config-cancel-btn">取消</button>
                </div>
            </div>
            <div class="content">
                <div class="input-row">
                    <label for="trade-amount">交易金额 (USDT):</label>
                    <input type="number" id="trade-amount" placeholder="输入金额" step="0.1" min="0.1" value="200">
                </div>
                <div class="input-row">
                    <label for="trade-count">买入次数限制:</label>
                    <input type="number" id="trade-count" placeholder="输入次数(0=无限制)" step="1" min="0" value="40">
                </div>
                <div class="status-display" id="status-display">等待开始</div>
                <div class="trade-counter" id="trade-counter">买入次数: 0/40</div>
                <div class="daily-stats" id="daily-stats">今日交易: 0次</div>
                <div class="control-buttons">
                    <button class="control-btn start-btn" id="start-btn">开始交易</button>
                    <button class="control-btn stop-btn" id="stop-btn" style="display: none;">停止交易</button>
                </div>
                <div class="smart-trading-control">
                    <div class="smart-switch-row">
                        <span class="smart-switch-label">智能交易</span>
                        <span id="smart-switch-state" class="smart-switch-state">关闭</span>
                        <label class="smart-switch" for="smart-trading-switch">
                            <input type="checkbox" id="smart-trading-switch" />
                            <span class="smart-slider"></span>
                        </label>
                    </div>
                </div>
                <div class="debug-buttons" style="margin-top: 8px;">
                    <button class="control-btn debug-btn" id="clear-log-btn">清空日志</button>
                </div>
                <div class="log-container" id="log-container"></div>
            </div>
        `;

        document.body.appendChild(this.ui);
        
        // Insert trend indicator above the first input-row
        const contentEl = this.ui.querySelector('.content');
        const firstInputRow = contentEl.querySelector('.input-row');
        const trendEl = document.createElement('div');
        trendEl.id = 'trend-indicator';
        trendEl.className = 'trend-indicator flat';
        trendEl.innerHTML = '<span id="trend-action" class="trend-action neutral">--</span><span id="trend-text">趋势: 计算中…</span>';
        contentEl.insertBefore(trendEl, firstInputRow);
        this.trendIndicator = trendEl;
        this.trendActionEl = trendEl.querySelector('#trend-action');
        this.trendTextEl = trendEl.querySelector('#trend-text');
        
        // 设置默认位置为左上角（悬浮可拖拽，固定宽高）
        this.ui.style.position = 'fixed';
        this.ui.style.left = '20px';
        this.ui.style.top = '20px';
        this.ui.style.bottom = '';
        this.ui.style.zIndex = '9999';
        
        this.logContainer = document.getElementById('log-container');
        this.statusDisplay = document.getElementById('status-display');
        this.tradeCounter = document.getElementById('trade-counter');
        this.dailyStats = document.getElementById('daily-stats');

        this.setupUIEvents();
        this.makeDraggable();
        this.loadDailyStats();
        this.loadUserConfig();
        
        // Start trend detection
        this.setupTrend();
    }

    // ================= 安全作用域与点击工具 =================
    // 找到交易面板根节点，并缓存
    getOrderFormRoot(refresh = false) {
        if (!refresh && this.orderRoot && document.body.contains(this.orderRoot)) return this.orderRoot;

        const candidates = [];
        // 通过“买入”按钮定位
        const allBtns = Array.from(document.querySelectorAll('button'))
            .filter(b => /买入/.test(b.textContent || '') && !/充值|卖出/.test(b.textContent || '') && this.isVisible(b));
        for (const b of allBtns) {
            const root = b.closest('[role="tabpanel"], form, [class*="panel"], [class*="buySell"], .w-full');
            if (root && this.isVisible(root) && /成交额|限价|市价|买入/.test(root.textContent || '')) {
                candidates.push(root);
            }
        }

        // 通过成交额输入定位
        const total = document.querySelector('#limitTotal') || Array.from(document.querySelectorAll('input')).find(i => /成交额|USDT|最小/.test(i.placeholder || '') || i.id === 'limitTotal');
        if (total) {
            const root = total.closest('[role="tabpanel"], form, [class*="panel"], [class*="buySell"], .w-full');
            if (root) candidates.push(root);
        }

        // 选择包含元素最多的容器作为根
        this.orderRoot = candidates.sort((a, b) => (b.querySelectorAll('*').length - a.querySelectorAll('*').length))[0] || null;
        return this.orderRoot;
    }

    isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return el.offsetParent !== null && r.width > 0 && r.height > 0;
    }

    isInHeader(el) {
        if (!el) return false;
        const headerLike = el.closest('.header-menu-item, [class*="header"], [id*="header"], [data-testid*="header"]');
        return !!headerLike;
    }


    // Setup and run the real-time trend detector (from trend.js)
    setupTrend() {
        if (!window.TrendDetector) {
            this.log('趋势模块未加载', 'error');
            return;
        }
        try {
            this.trendDetector = new window.TrendDetector({
                windowMs: 45000,
                maxTrades: 300,
                updateIntervalMs: 800,
                onUpdate: (s) => this.renderTrend(s)
            });
            this.trendDetector.start();
            this.log('趋势监测已启动', 'info');
        } catch (e) {
            this.log(`趋势监测启动失败: ${e.message}`, 'error');
        }
    }

    renderTrend(state) {
        if (!this.trendIndicator || !state) return;
        const { label, score, details } = state;
        const pct = (x) => (x * 100).toFixed(2) + '%';
        const info = details
            ? `VWAP偏离 ${pct(details.vwapDiff)} · 量差 ${(details.imbalance * 100).toFixed(1)}% · n=${details.nTrades}`
            : '';

        // Update text
        if (this.trendTextEl) {
            this.trendTextEl.textContent = `趋势: ${label} (${(score*100).toFixed(2)}%) ${info ? info : ''}`;
        }

        // Update color frame
        this.trendIndicator.classList.remove('up', 'down', 'flat');
        if (label === '上涨') this.trendIndicator.classList.add('up');
        else if (label === '下降') this.trendIndicator.classList.add('down');
        else this.trendIndicator.classList.add('flat');

        // Map label to internal code and store as recent signal
        const map = { '上涨': 'rising', '下降': 'falling', '平缓': 'flat' };
        const trendCode = map[label] || 'unknown';
        this.previousTrend = this.currentTrend;
        this.currentTrend = trendCode;
        const trendString = `趋势: ${label} (${(score*100).toFixed(2)}%) ${info}`;
        const currentPrice = details?.lastPrice ?? 0;
        this.storeTrendData(trendString, trendCode, currentPrice);

        // Update action pill based on last 3 signals
        const action = this.computeActionFromSignals();
        this.applyTrendAction(action);

        // Smart session: only在运行期间检查趋势条件
        if (this.smartTradingMode && this.isRunning && this.sessionMode === 'smart') {
            this.checkSmartTradingConditions();
        }
    }

    // Decide UI action pill from the latest 3 signals
    computeActionFromSignals() {
        const s = this.getRecentSignals(3);
        if (s.includes('falling')) return { type: 'stop', text: '停止' };
        if (s.length === 3 && s[0] === 'rising' && s[1] === 'rising' && s[2] === 'flat') {
            return { type: 'buy', text: '买入' };
        }
        if (s.length === 3 && s[0] === 'flat' && s[1] === 'flat' && s[2] === 'flat') {
            return { type: 'caution', text: '谨买' };
        }
        return { type: 'neutral', text: '--' };
    }

    applyTrendAction(action) {
        if (!this.trendActionEl || !action) return;
        this.trendActionEl.classList.remove('buy', 'stop', 'caution', 'neutral');
        this.trendActionEl.classList.add(action.type || 'neutral');
        this.trendActionEl.textContent = action.text || '--';
    }

    setupUIEvents() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        const minimizeBtn = document.getElementById('minimize-btn');
        const clearLogBtn = document.getElementById('clear-log-btn');
        const configBtn = document.getElementById('config-btn');
        const configSaveBtn = document.getElementById('config-save-btn');
        const configCancelBtn = document.getElementById('config-cancel-btn');
        const smartTradingSwitch = document.getElementById('smart-trading-switch');

        startBtn.addEventListener('click', () => this.startTrading());
        stopBtn.addEventListener('click', () => this.stopTrading());
        minimizeBtn.addEventListener('click', () => this.toggleMinimize());
        clearLogBtn.addEventListener('click', () => this.clearLogs());
        configBtn.addEventListener('click', () => this.toggleConfigPanel());
        configSaveBtn.addEventListener('click', () => this.saveConfig());
        configCancelBtn.addEventListener('click', () => this.cancelConfig());
        if (smartTradingSwitch) {
            smartTradingSwitch.addEventListener('change', (e) => this.setSmartTradingMode(!!e.target.checked));
        }
    }

    makeDraggable() {
        const header = this.ui.querySelector('.header');
        let isDragging = false;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            this.ui.classList.add('dragging');
            const rect = this.ui.getBoundingClientRect();
            this.dragOffset.x = e.clientX - rect.left;
            this.dragOffset.y = e.clientY - rect.top;
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            
            const x = e.clientX - this.dragOffset.x;
            const y = e.clientY - this.dragOffset.y;
            
            this.ui.style.left = Math.max(0, Math.min(window.innerWidth - this.ui.offsetWidth, x)) + 'px';
            this.ui.style.top = Math.max(0, Math.min(window.innerHeight - this.ui.offsetHeight, y)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                this.ui.classList.remove('dragging');
            }
        });
    }

    toggleMinimize() {
        this.ui.classList.toggle('minimized');
    }

    setupMessageListener() {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.action === 'start') {
                this.currentAmount = message.amount;
                document.getElementById('trade-amount').value = message.amount;
                
                if (message.tradeCount !== undefined) {
                    document.getElementById('trade-count').value = message.tradeCount;
                }
                
                this.startTrading();
            } else if (message.action === 'stop') {
                this.stopTrading();
            } else if (message.action === 'emergency_stop') {
                // Handle emergency stop triggered via runtime messaging
                this.autoStopAndSellAll();
            }
        });
    }

    async startTrading() {
        if (this.isRunning) {
            this.log('⚠️ 交易已在进行中', 'warning');
            return;
        }

        const isSmartSession = this.smartTradingMode;

        let amount = parseFloat(document.getElementById('trade-amount').value);
        if (!amount || amount < 0.1) {
            this.log('请输入有效金额（≥0.1 USDT）', 'error');
            return;
        }

        const tradeCount = parseInt(document.getElementById('trade-count').value) || 0;

        if (!this.performSafetyChecks()) {
            return;
        }

		// Persist the current inputs as defaults for next session
		try {
			await this.setStorageData('userConfig', {
				amount: amount,
				count: tradeCount,
				delay: this.tradeDelay,
				sellDiscountRate: this.sellDiscountRate,
				smartTradingMode: this.smartTradingMode
			});
			this.log('已保存启动时的金额与次数到本地', 'info');
		} catch (e) {
			this.log(`Persist user config failed: ${e.message}`, 'error');
		}

        this.isRunning = true;
        this.sessionMode = isSmartSession ? 'smart' : 'manual';
        this.forceStop = false;
        this.isSmartTradingExecution = false;
        this.currentAmount = amount;
        this.maxTradeCount = tradeCount;
        this.currentTradeCount = 0;

        if (isSmartSession) {
            this.buyAmountRatio = 1.0;
            this.lastFallingSignalIndex = -1;
            this.canStartBuying = true;
        }

        this.updateUI();
        this.updateTradeCounter();

        this.log(isSmartSession ? '🤖 智能交易启动，等待趋势信号' : '🚀 开始自动买入', 'success');
        this.log(`💰 基础交易金额: ${amount} USDT`, 'info');
        if (tradeCount > 0) {
            this.log(`📊 限制次数: ${tradeCount}`, 'info');
        } else {
            this.log('📊 无次数限制', 'info');
        }

        if (isSmartSession) {
            this.log('📡 将根据趋势信号择机下单', 'info');
            // 立即检查一次当前信号，避免错过已经满足条件的情况
            this.checkSmartTradingConditions();
        } else {
            try {
                await this.runTradingLoop();
            } catch (error) {
                this.log(`交易过程出错: ${error.message}`, 'error');
                this.stopTrading();
            }
        }
    }

    performSafetyChecks() {
        // 检查页面URL
        if (!window.location.href.includes('binance.com/zh-CN/alpha/')) {
            this.log('错误：不在币安Alpha交易页面', 'error');
            return false;
        }

        // 检查用户是否已登录
        const loginElements = document.querySelectorAll('[class*="login"], [class*="登录"]');
        if (loginElements.length > 0) {
            this.log('警告：请先登录币安账户', 'error');
            return false;
        }

        // 检查是否能找到交易界面
        const tradingInterface = document.querySelector('.bn-tabs__buySell') || 
                                document.querySelector('[role="tablist"]');
        if (!tradingInterface) {
            this.log('错误：未找到交易界面，请刷新页面', 'error');
            return false;
        }

        // 检查网络连接
        if (!navigator.onLine) {
            this.log('错误：网络连接断开', 'error');
            return false;
        }

        this.log('安全检查通过', 'success');
        return true;
    }

    stopTrading() {
        const wasRunning = this.isRunning;
        const completedTrades = this.currentTradeCount;
        
        this.isRunning = false;
        this.currentState = 'idle';
        this.forceStop = false; // 重置强制停止标志
        this.isSmartTradingExecution = false; // 重置智能交易执行标志
        this.sessionMode = 'idle';
        this.clearCountdown(); // 清除倒计时
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
        // 保留本次会话的交易次数，便于用户查看已完成次数
        
        this.updateUI();
        this.updateTradeCounter();
        
        if (wasRunning) {
            this.log('买入已停止', 'info');
            if (completedTrades > 0) {
                this.log(`本次交易完成，共执行 ${completedTrades} 次买入`, 'info');
            } else {
                this.log('本次交易未执行任何买入操作', 'info');
            }
        } else {
            this.log('买入已停止（未在运行状态）', 'info');
        }
    }




    async autoStopAndSellAll() {
        this.log('=== 自动停止 ===', 'error');
        
        // 立即停止所有交易活动
        this.isRunning = false;
        this.currentState = 'auto_stop';
        this.sessionMode = 'idle';
        
        if (this.orderCheckInterval) {
            clearInterval(this.orderCheckInterval);
            this.orderCheckInterval = null;
        }
        
        this.log('=== 自动停止完成 ===', 'success');
        this.updateUI();
    }


    updateUI() {
        const startBtn = document.getElementById('start-btn');
        const stopBtn = document.getElementById('stop-btn');
        
        if (this.isRunning) {
            startBtn.style.display = 'none';
            stopBtn.style.display = 'block';
            stopBtn.textContent = '停止交易';
            if (this.sessionMode === 'smart') {
                this.statusDisplay.textContent = '智能交易运行中';
                this.statusDisplay.className = 'status-display smart-trading';
            } else {
                this.statusDisplay.textContent = '买入运行中';
                this.statusDisplay.className = 'status-display running';
            }
        } else {
            startBtn.style.display = 'block';
            stopBtn.style.display = 'none';
            startBtn.disabled = false;
            startBtn.textContent = '开始交易';
            startBtn.title = '';
            if (this.smartTradingMode) {
                this.statusDisplay.textContent = '智能交易待机';
                this.statusDisplay.className = 'status-display smart-trading';
            } else {
                this.statusDisplay.textContent = '等待开始';
                this.statusDisplay.className = 'status-display';
            }
        }
    }

    updateTradeCounter() {
        if (this.maxTradeCount > 0) {
            this.tradeCounter.textContent = `买入次数: ${this.currentTradeCount}/${this.maxTradeCount}`;
            
            // 根据进度改变颜色
            const progress = this.currentTradeCount / this.maxTradeCount;
            if (progress >= 0.8) {
                this.tradeCounter.className = 'trade-counter warning';
            } else if (progress >= 0.5) {
                this.tradeCounter.className = 'trade-counter info';
            } else {
                this.tradeCounter.className = 'trade-counter';
            }
        } else {
            this.tradeCounter.textContent = `买入次数: ${this.currentTradeCount}/无限制`;
            this.tradeCounter.className = 'trade-counter';
        }
    }

    async runTradingLoop() {
        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;
        
        while (this.isRunning) {
            try {
                // 检查强制停止标志
                if (this.forceStop) {
                    this.log('检测到强制停止标志，立即停止交易循环', 'warning');
                    break;
                }
                
                // 达到买入次数上限的前置检查
                if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
                    this.log(`🛑 已达到买入次数限制 (${this.currentTradeCount}/${this.maxTradeCount})，自动停止`, 'warning');
                    this.stopTrading();
                    break;
                }
                
                // 每次循环前检查页面状态
                if (!this.performRuntimeChecks()) {
                    await this.sleep(5000); // 等待5秒后重试
                    continue;
                }

                // 步骤1: 执行买入
                await this.executeBuyWithRetry();
                if (!this.isRunning) break;

                // 步骤2: 等待买入完成
                await this.waitForBuyComplete();
                if (!this.isRunning) break;

                // 步骤3: 最终确认买入已完成
                const buyConfirmed = await this.finalBuyConfirmation();
                if (!buyConfirmed) {
                    this.log('买入未成功，跳过此轮买入', 'error');
                    await this.sleep(5000); // 等待5秒后重试
                    continue;
                }

                consecutiveErrors = 0; // 重置错误计数
                this.currentTradeCount++; // 增加交易次数
                this.updateTradeCounter(); // 更新交易次数显示
                
                // 更新每日统计
                await this.incrementDailyTradeCount();
                
                const tradeDuration = Date.now() - this.tradeStartTime;
                this.log(`第 ${this.currentTradeCount} 轮买入完成 (耗时: ${tradeDuration}ms)`, 'success');
                
                // 检查是否达到买入次数限制
                if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
                    this.log(`⚠️ 已达到买入次数限制 (${this.maxTradeCount})，自动停止`, 'error');
                    this.stopTrading();
                    break;
                }
                
                // 提前警告功能
                if (this.maxTradeCount > 0) {
                    const remaining = this.maxTradeCount - this.currentTradeCount;
                    if (remaining <= 2 && remaining > 0) {
                        this.log(`⚠️ 警告：还剩 ${remaining} 次买入后将自动停止`, 'error');
                    } else if (remaining <= 5 && remaining > 2) {
                        this.log(`⚠️ 提醒：还剩 ${remaining} 次买入后将自动停止`, 'info');
                    }
                }
                
                this.log('⏳ 等待下一轮买入...', 'info');
                
                // 智能交易模式下，不检查停止条件，只保留买入信号
                
                // 记录当前交易进度
                if (this.maxTradeCount > 0) {
                    const remaining = this.maxTradeCount - this.currentTradeCount;
                    this.log(`📈 交易进度: ${this.currentTradeCount}/${this.maxTradeCount} (剩余: ${remaining})`, 'info');
                }
                
                // 使用配置的延迟时间（秒转毫秒）
                const delaySeconds = typeof this.tradeDelay === 'number' ? this.tradeDelay : 0;
                if (delaySeconds > 0) {
                    const delayMs = delaySeconds * 1000;
                    this.startCountdown(delaySeconds, '买入延迟');
                    await this.sleep(delayMs);
                }

            } catch (error) {
                consecutiveErrors++;
                this.log(`买入循环出错 (${consecutiveErrors}/${maxConsecutiveErrors}): ${error.message}`, 'error');
                
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    this.log('连续错误次数过多，停止买入', 'error');
                    break;
                }
                
                // 等待后重试
                await this.sleep(5000);
            }
        }
    }

    performRuntimeChecks() {
        // 检查网络连接
        if (!navigator.onLine) {
            this.log('网络连接断开，等待重连...', 'error');
            return false;
        }

        // 检查页面是否还在交易页面
        if (!window.location.href.includes('binance.com/zh-CN/alpha/')) {
            this.log('页面已离开交易界面', 'error');
            return false;
        }

        return true;
    }

    async executeBuyWithRetry(maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.executeBuy();
                return;
            } catch (error) {
                this.log(`买入操作失败 (${i + 1}/${maxRetries}): ${error.message}`, 'error');
                if (i === maxRetries - 1) throw error;
                await this.sleep(2000);
            }
        }
    }



    async executeBuy() {
        // 检查强制停止标志
        if (this.forceStop) {
            this.log('检测到强制停止标志，跳过买入操作', 'warning');
            return;
        }
        
        this.tradeStartTime = Date.now(); // 记录交易开始时间
        this.currentState = 'buying';
        this.log('🔄 开始执行买入操作', 'info');
        this.log(`📊 第 ${this.currentTradeCount + 1} 次买入`, 'info');

        // 0. 充值弹窗检查已移除，简化代码逻辑

        // 1. 确保在买入选项卡
        await this.switchToBuyTab();
        
        // 2. 勾选反向订单
        await this.checkReverseOrder();
        
        // 3. 设置卖出价格（建议价格下浮1%）
        await this.setSellPrice();
        
        // 5. 设置成交额（带安全缓冲，避免实际撮合金额略高于目标）
        const adjustedAmount = this.getAdjustedBuyAmount(this.currentAmount);
        if (adjustedAmount !== this.currentAmount) {
            this.log(`买入金额调整: 目标=${this.currentAmount} USDT -> 调整后=${adjustedAmount} USDT`, 'info');
        }
        await this.setTotalAmount(adjustedAmount);
        
        // 5.5. 余额不足/充值CTA前置拦截（严格按流程文档）
        await this.verifySufficientBalanceOrStop();

        // 6. 点击买入按钮
        await this.clickBuyButton();
        
        this.log('✅ 买入操作执行完成', 'success');
        this.log('📤 买入订单已提交', 'success');
    }

    // 在买入按钮点击前，明确检查买入区的主CTA是否为“添加USDT余额/充值/余额不足”等，若是则停止
    async verifySufficientBalanceOrStop() {
        try {
            const root = this.getOrderFormRoot();
            if (!root) return; // 没有根容器则交由后续校验处理

            // 优先找与买入相关的全宽按钮
            const ctas = Array.from(root.querySelectorAll('button'))
                .filter(btn => this.isVisible(btn) && /w-full/.test(btn.className || ''));

            // 最近/最可能的CTA（一般结构中买入/充值按钮是最靠近成交额区域的全宽按钮）
            const primaryCTA = ctas[0] || null;
            if (!primaryCTA) return;

            const text = (primaryCTA.textContent || '').trim();
            const isDepositLike = ['添加USDT余额', '充值', 'Add USDT', 'Add balance', 'Add funds', 'Top up', 'Deposit', '余额不足', 'Insufficient'].some(k => text.includes(k));

            if (isDepositLike) {
                this.log(`余额不足检测到充值CTA: "${text}"，已停止本次操作（不点击充值）`, 'error');
                // 按流程要求：显示日志“余额不足，不要点击”，并停止
                this.log('余额不足，不要点击', 'error');
                throw new Error('余额不足：检测到充值CTA，终止本次买入');
            }
        } catch (e) {
            if (e && e.message && e.message.includes('余额不足')) throw e;
            // 其他异常不阻断后续流程，但记录日志供排查
            this.log(`余额检查异常（忽略继续）: ${e.message || e}`, 'warning');
        }
    }


    // 勾选反向订单
    async checkReverseOrder() {
        this.log('勾选反向订单...', 'info');
        
        // 首先尝试在交易面板根节点内查找
        const root = this.getOrderFormRoot();
        let reverseOrderCheckbox = null;
        
        if (root) {
            reverseOrderCheckbox = root.querySelector('div[role="checkbox"][aria-checked="false"]');
            if (!reverseOrderCheckbox) {
                // 若找不到未勾选的，检查是否已勾选
                const checkedBox = root.querySelector('div[role="checkbox"][aria-checked="true"]');
                if (checkedBox) {
                    this.log('反向订单已勾选', 'info');
                    return;
                }
            }
        }
        
        // 如果根节点查找失败，使用全局查找作为备用
        if (!reverseOrderCheckbox) {
            this.log('在交易面板根节点内未找到反向订单，尝试全局查找...', 'info');
            reverseOrderCheckbox = document.querySelector('div[role="checkbox"][aria-checked="false"]');
            if (!reverseOrderCheckbox) {
                // 若找不到未勾选的，检查是否已勾选
                const checkedBox = document.querySelector('div[role="checkbox"][aria-checked="true"]');
                if (checkedBox) {
                    this.log('反向订单已勾选', 'info');
                    return;
                }
                throw new Error('未找到反向订单复选框');
            }
        }
        
        // 直接点击反向订单复选框
        reverseOrderCheckbox.click();
        
        // 验证是否勾选成功
        const isChecked = reverseOrderCheckbox.getAttribute('aria-checked') === 'true';
        if (isChecked) {
            this.log('反向订单勾选成功', 'success');
        } else {
            throw new Error('反向订单勾选失败');
        }
    }

    // 设置买入价格和卖出价格
    async setSellPrice() {
        this.log('设置买入价格和卖出价格...', 'info');
        
        // 1. 获取建议价格
        let suggestedPriceText = document.querySelector('div.text-PrimaryText.cursor-pointer.ml-\\[4px\\]');
        if (!suggestedPriceText) {
            // 备用查找方式
            const priceElements = document.querySelectorAll('div[class*="text-PrimaryText"][class*="cursor-pointer"]');
            let foundElement = null;
            for (const element of priceElements) {
                if (element.textContent.includes('$') && element.textContent.match(/\d+\.\d+/)) {
                    foundElement = element;
                    break;
                }
            }
            if (!foundElement) {
                throw new Error('未找到建议价格文本');
            }
            suggestedPriceText = foundElement;
        }
        
        // 从建议价格文本中提取价格数字
        const priceText = suggestedPriceText.textContent;
        const priceMatch = priceText.match(/\$?([\d.]+)/);
        if (!priceMatch) {
            throw new Error('无法从建议价格文本中提取价格');
        }
        
        const suggestedPrice = parseFloat(priceMatch[1]);
        if (isNaN(suggestedPrice) || suggestedPrice <= 0) {
            throw new Error('建议价格格式无效');
        }
        
        this.log(`获取到建议价格: ${suggestedPrice}`, 'info');
        
        // 2. 设置买入价格
        const buyPriceInput = document.querySelector('input[step="1e-8"]');
        if (!buyPriceInput) {
            throw new Error('未找到买入价格输入框');
        }
        
        // 设置买入价格
        buyPriceInput.focus();
        buyPriceInput.select();
        buyPriceInput.value = '';
        
        const buyPriceFormatted = suggestedPrice.toFixed(8);
        buyPriceInput.value = buyPriceFormatted;
        buyPriceInput.dispatchEvent(new Event('input', { bubbles: true }));
        buyPriceInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        this.log(`买入价格设置完成: ${buyPriceFormatted}`, 'success');
        
        // 3. 计算并设置卖出价格（应用折价率）
        const discountMultiplier = 1 - this.sellDiscountRate;
        const sellPrice = suggestedPrice * discountMultiplier;
        const sellPriceFormatted = sellPrice.toFixed(8);
        
        this.log(`计算卖出价格: ${suggestedPrice} * ${discountMultiplier.toFixed(3)} = ${sellPriceFormatted} (折价率: ${(this.sellDiscountRate * 100).toFixed(1)}%)`, 'info');
        
        // 查找卖出价格输入框
        const sellPriceInput = document.querySelector('input[placeholder="限价卖出"]');
        if (!sellPriceInput) {
            throw new Error('未找到卖出价格输入框');
        }
        
        // 设置卖出价格
        sellPriceInput.focus();
        sellPriceInput.select();
        sellPriceInput.value = '';
        
        sellPriceInput.value = sellPriceFormatted;
        sellPriceInput.dispatchEvent(new Event('input', { bubbles: true }));
        sellPriceInput.dispatchEvent(new Event('change', { bubbles: true }));
        
        this.log(`卖出价格设置完成: ${sellPriceFormatted}`, 'success');
    }

    // 计算带安全缓冲的买入金额，并做向下取小数位处理，降低超额风险
    getAdjustedBuyAmount(amount) {
        const a = Number(amount) || 0;
        if (a <= 0) return a;
        const buffered = a * (1 - (this.buyAmountSafetyBuffer || 0));
        // 成交额输入通常是USDT，保留2位并向下取，尽量不超出目标
        const floored = Math.floor(buffered * 100) / 100;
        return Math.max(0.01, Number(floored.toFixed(2)));
    }

    async switchToBuyTab() {
        this.log('开始切换到买入选项卡', 'info');
        
        // 使用更精确的选择器，避免误触其他按钮
        let buyTab = this.getCachedElement('buyTab', '#bn-tab-0.bn-tab__buySell');
        if (!buyTab) {
            // 优先使用ID选择器
            buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
            if (!buyTab) {
                // 备用选择器：确保是买入相关的选项卡
                const tablist = document.querySelector('[role="tablist"], .bn-tabs__buySell');
                buyTab = tablist ? Array.from(tablist.querySelectorAll('[role="tab"], .bn-tab__buySell')).find(t => /买入|Buy/.test(t.textContent || '')) : null;
            }
            this.cachedElements.buyTab = buyTab;
        }
        
        if (!buyTab) {
            throw new Error('未找到买入选项卡');
        }
        
        // 额外验证：确保不是充值相关的元素
        if (buyTab.textContent.includes('充值') || buyTab.classList.contains('deposit-btn')) {
            throw new Error('检测到充值相关元素，跳过点击');
        }
        
        // 检查是否已经是活跃状态
        if (this.isBuyTabActive()) {
            this.log('已在买入选项卡', 'info');
            return;
        }
        
        // 点击切换
        // 直接点击买入选项卡
        buyTab.click();
        this.log('点击买入选项卡', 'info');
        
        // 等待并验证切换结果
        const switchSuccess = await this.waitForBuyTabSwitch();
        if (!switchSuccess) {
            this.debugTabState(); // 失败时输出状态
            throw new Error('切换到买入选项卡失败，终止执行');
        }
        
        this.log('成功切换到买入选项卡', 'success');
    }

    isBuyTabActive() {
        const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
        if (!buyTab) return false;
        
        return buyTab.getAttribute('aria-selected') === 'true' && 
               buyTab.classList.contains('active');
    }

    async waitForBuyTabSwitch(maxAttempts = 6) { // 减少重试次数
        for (let i = 0; i < maxAttempts; i++) {
            await this.sleep(10); // 减少等待时间
            
            if (this.isBuyTabActive()) {
                this.log('买入选项卡切换成功', 'success');
                return true;
            }
            
            // 如果切换失败，再次尝试点击
            if (i < maxAttempts - 1) {
                this.log(`买入选项卡切换中... (${i + 1}/${maxAttempts})`, 'info');
                const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
                if (buyTab && !buyTab.textContent.includes('充值') && !buyTab.classList.contains('deposit-btn')) {
                    buyTab.click();
                } else {
                    this.log('检测到充值相关元素，跳过重复点击', 'warning');
                }
            }
        }
        
        this.log('买入选项卡切换失败', 'error');
        return false;
    }

    async setTotalAmount(amount) {
        // 使用缓存的成交额输入框
        const root = this.getOrderFormRoot();
        let totalInput = this.getCachedElement('totalInput', '#limitTotal');
        if (!totalInput) {
            // 首先在交易面板根节点内查找
            if (root) {
                totalInput = root.querySelector('#limitTotal') ||
                            root.querySelector('input[placeholder*="最小"]') ||
                            root.querySelector('input[step="1e-8"]');
            }
            
            // 如果根节点查找失败，使用全局查找作为备用
            if (!totalInput) {
                this.log('在交易面板根节点内未找到成交额输入框，尝试全局查找...', 'info');
                totalInput = document.querySelector('#limitTotal') ||
                            document.querySelector('input[placeholder*="最小"]') ||
                            document.querySelector('input[step="1e-8"]');
            }
            
            this.cachedElements.totalInput = totalInput;
        }

        if (!totalInput) {
            throw new Error('未找到成交额输入框');
        }

        // 清空并设置新值
        totalInput.focus();
        totalInput.select();
        totalInput.value = '';
        
        // 模拟输入
        const inputEvent = new Event('input', { bubbles: true });
        const changeEvent = new Event('change', { bubbles: true });
        
        totalInput.value = amount.toString();
        totalInput.dispatchEvent(inputEvent);
        totalInput.dispatchEvent(changeEvent);
        
        await this.sleep(10); // 减少到50ms
        this.log(`设置成交额: ${amount} USDT`, 'info');
    }

    async clickBuyButton() {
        // 检查弹窗处理时序
        const timeSinceLastModal = Date.now() - this.lastModalProcessTime;
        if (timeSinceLastModal < this.modalProcessingDelay) {
            const waitTime = this.modalProcessingDelay - timeSinceLastModal;
            this.log(`⏳ 距离上次弹窗处理太近，等待 ${waitTime}ms`, 'info');
            await this.sleep(waitTime);
        }

        if (this.confirmationInProgress) {
            this.log('⚠️ 确认操作正在进行中，跳过重复点击', 'warning');
            throw new Error('确认操作正在进行中，避免重复点击');
        }

        // 检查当前USDT余额是否足够（提前检查，避免无效操作）
        const hasEnoughBalance = await this.checkUSDTBalance();
        if (!hasEnoughBalance) {
            this.log('⚠️ USDT余额不足，停止交易避免触发充值', 'error');
            throw new Error('USDT余额不足，已停止交易');
        }

        // 使用精确选择器查找买入按钮
        let buyButton = this.getCachedElement('buyButton', 'button.bn-button.bn-button__buy.w-full');
        
        if (!buyButton) {
            // 根据Buy_Process.md，买入按钮的精确选择器
            buyButton = document.querySelector('button.bn-button.bn-button__buy.data-size-middle.w-full') ||
                       document.querySelector('button.bn-button.bn-button__buy.w-full') ||
                       Array.from(document.querySelectorAll('button.bn-button.bn-button__buy')).find(btn => 
                           btn.textContent.includes('买入') && 
                           !btn.textContent.includes('充值') && 
                           !btn.disabled &&
                           btn.classList.contains('w-full')
                       );
            this.cachedElements.buyButton = buyButton;
        }

        if (!buyButton) {
            throw new Error('未找到买入按钮');
        }

        // 额外验证：确保不是充值按钮
        const buttonText = buyButton.textContent || '';
        if (buttonText.includes('充值') || buttonText.includes('添加USDT') || buyButton.classList.contains('deposit-btn')) {
            this.log(`❌ 检测到充值相关按钮: "${buttonText}"`, 'error');
            throw new Error('检测到充值按钮，跳过点击');
        }

        if (buyButton.disabled) {
            throw new Error('买入按钮不可用');
        }

        // 再次检查是否有未处理的弹窗（双重保险）
        const existingModals = this.getVisibleModals ? this.getVisibleModals() : [];
        if (existingModals.length > 0) {
            this.log(`⚠️ 发现 ${existingModals.length} 个未处理的弹窗，先处理后再下单`, 'warning');
            await this.handleExistingModals(existingModals);
        }

        // 设置确认互斥锁，防止在确认完成前再次点击买入
        this.confirmationInProgress = true;

        try {
            // 直接点击
            this.log(`点击买入按钮: "${buttonText}"`, 'info');
            buyButton.click();
            await this.sleep(200); // 增加等待时间，确保弹窗完全加载
            this.log('买入按钮点击完成，等待确认弹窗...', 'success');

            // 检查并处理确认弹窗
            await this.handleBuyConfirmationDialog({ allowPageFallback: true, requireResolve: true, timeoutMs: 15000 });
            
            // 记录弹窗处理完成时间
            this.lastModalProcessTime = Date.now();
            
        } finally {
            this.confirmationInProgress = false;
        }
    }

    async handleBuyConfirmationDialog(options = {}) {
        const { allowPageFallback = true, requireResolve = false, timeoutMs = 10000 } = options;
        this.log('检查买入确认弹窗...', 'info');
        
        // 等待弹窗出现
        await this.sleep(120);
        
        // 多次检测弹窗，提高检测成功率
        let confirmButton = null;
        let attempts = 0;
        const maxAttempts = Math.max(6, Math.floor(timeoutMs / 250));
        
        while (attempts < maxAttempts && !confirmButton) {
            attempts++;
            this.log(`等待弹窗出现... (${attempts}/${maxAttempts})`, 'info');
            await this.sleep(250);

            // 检查是否存在多个弹窗（重复弹窗问题）
            const visibleModals = this.getVisibleModals ? this.getVisibleModals() : [];
            if (visibleModals.length > 1) {
                this.log(`⚠️ 检测到${visibleModals.length}个弹窗，可能存在重复弹窗`, 'warning');
                // 关闭多余的弹窗
                await this.closeExtraModals(visibleModals);
            }

            // 若检测到充值/余额不足类弹窗，立即停止并返回失败
            if (visibleModals.length > 0) {
                const topModal = visibleModals[0];
                if (topModal && this.isDepositModalText && this.isDepositModalText(topModal.text)) {
                    this.log('检测到充值/余额不足弹窗，安全停止，避免误点充值', 'error');
                    this.log(`弹窗内容: ${topModal.text.substring(0, 100)}...`, 'error');
                    // 尝试关闭充值弹窗
                    await this.closeDepositModal(topModal.el);
                    throw new Error('余额不足或充值弹窗出现，已停止当前交易');
                }
            }

            // 查找确认弹窗中的按钮
            confirmButton = this.findBuyConfirmButton({ allowPageFallback });
            
            // 如果找到按钮，立即跳出循环
            if (confirmButton) {
                break;
            }
        }
        
        if (confirmButton) {
            this.log('发现买入确认弹窗，准备点击确认按钮', 'info');
            
            // 记录点击前弹窗状态（避免递归调用）
            const beforeClickExists = true; // Found confirmButton implies modal existed
            this.log(`点击前弹窗存在: ${beforeClickExists}`, 'info');
            
            // 确保按钮可见和可点击
            confirmButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await this.sleep(10);
            
            let clickSuccess = false;
            
            // 方式1: 聚焦并直接点击
            try {
                confirmButton.focus();
                await this.sleep(100);
                confirmButton.click();
                await this.sleep(800); // 等待观察效果

                // 点击后仅在弹窗范围内检查，避免整页按钮造成误判
                const afterClickExists = this.findBuyConfirmButton({ allowPageFallback: false }) !== null;
                this.log(`点击后弹窗存在: ${afterClickExists}`, 'info');
                
                if (beforeClickExists && !afterClickExists) {
                    clickSuccess = true;
                    this.log('✅ 直接点击成功，弹窗已消失', 'success');
                } else if (beforeClickExists && afterClickExists) {
                    this.log('⚠️ 直接点击后弹窗仍存在，尝试其他方式', 'warning');
                }
            } catch (error) {
                this.log(`直接点击失败: ${error.message}`, 'warning');
            }
            
            // 方式2: 如果直接点击失败，尝试多种事件
            if (!clickSuccess && beforeClickExists) {
                this.log('尝试事件点击...', 'info');
                try {
                    // 触发完整的点击事件序列
                    const events = [
                        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
                        new MouseEvent('mouseup', { bubbles: true, cancelable: true }),
                        new MouseEvent('click', { bubbles: true, cancelable: true })
                    ];
                    
                    for (const event of events) {
                        confirmButton.dispatchEvent(event);
                        await this.sleep(50);
                    }
                    
                    await this.sleep(800);

                    // 再次仅在弹窗范围内检查
                    const finalExists = this.findBuyConfirmButton({ allowPageFallback: false }) !== null;
                    this.log(`事件点击后弹窗存在: ${finalExists}`, 'info');
                    
                    if (!finalExists) {
                        clickSuccess = true;
                        this.log('✅ 事件点击成功，弹窗已消失', 'success');
                    }
                } catch (eventError) {
                    this.log(`事件点击失败: ${eventError.message}`, 'warning');
                }
            }
            
            if (clickSuccess) {
                this.log('✅ 确认按钮点击成功，买入订单已确认', 'success');
            } else {
                this.log('❌ 确认按钮点击失败，弹窗仍然存在，跳过此次交易', 'error');
                // 抛出错误以停止当前交易流程
                throw new Error('确认弹窗无法关闭，停止交易避免重复操作');
            }
        } else {
            if (requireResolve) {
                const stillHasModal = this.hasVisibleModal && this.hasVisibleModal();
                if (stillHasModal) {
                    throw new Error('存在未识别的弹窗，已阻止重复下单');
                }
            }
            this.log('未发现买入确认弹窗，继续执行', 'info');
        }
    }

    // 检查USDT余额是否足够 - 根据Buy_Process.md优化
    async checkUSDTBalance() {
        try {
            // 方法1: 直接检查买入按钮是否变成了"添加USDT余额"按钮（最关键的检测）
            const primaryButtons = document.querySelectorAll('button.bn-button.bn-button__primary.w-full');
            for (const button of primaryButtons) {
                const buttonText = (button.textContent || '').trim();
                if (buttonText === '添加USDT余额' || buttonText.includes('添加USDT') || buttonText.includes('充值')) {
                    this.log(`❌ 检测到充值按钮: "${buttonText}"，余额不足`, 'error');
                    return false;
                }
            }

            // 方法2: 检查正常的买入按钮是否存在且可用
            const buyButtons = document.querySelectorAll('button.bn-button.bn-button__buy.w-full');
            let hasFunctionalBuyButton = false;
            for (const button of buyButtons) {
                const buttonText = (button.textContent || '').trim();
                if (buttonText.includes('买入') && !button.disabled && !buttonText.includes('充值')) {
                    hasFunctionalBuyButton = true;
                    this.log(`✅ 找到正常买入按钮: "${buttonText}"`, 'info');
                    break;
                }
            }

            if (!hasFunctionalBuyButton) {
                this.log('❌ 未找到可用的买入按钮，可能余额不足', 'warning');
                return false;
            }

            // 方法3: 检查成交额输入框附近是否有余额不足提示
            const totalInput = document.querySelector('#limitTotal');
            if (totalInput) {
                const parent = totalInput.closest('.bn-textField') || totalInput.parentElement;
                const siblingElements = parent ? Array.from(parent.parentElement.children) : [];
                for (const sibling of siblingElements) {
                    const text = sibling.textContent || '';
                    if (text.includes('余额不足') || text.includes('Insufficient')) {
                        this.log('❌ 成交额输入框附近发现余额不足提示', 'warning');
                        return false;
                    }
                }
            }

            this.log('✅ 余额检查通过', 'success');
            return true;
        } catch (error) {
            this.log(`检查USDT余额失败: ${error.message}`, 'error');
            return true; // 出错时假设足够，避免误判
        }
    }

    // 检查是否为充值按钮
    isDepositButton(button) {
        if (!button) return false;
        const text = (button.textContent || '').trim();
        const cls = button.className || '';
        const isDepositKeyword = [
            '充值', '存入', '划转', 'Add USDT', 'Add balance', 'Add funds', 'Top up', 'Deposit',
            '添加USDT余额', 'USDT余额', '余额不足', 'Insufficient', 'Insufficient balance', 'Buy USDT'
        ].some(k => text.includes(k));
        return button.classList.contains('deposit-btn') ||
               !!button.querySelector?.('.deposit-icon') ||
               cls.includes('deposit') ||
               isDepositKeyword;
    }

    isInOrderForm(element) {
        if (!element) return false;
        const orderRoot = this.getOrderFormRoot();
        return !!(orderRoot && orderRoot.contains(element));
    }

    hasVisibleModal() {
        const modals = this.getVisibleModals?.() || [];
        return modals.length > 0;
    }

    getVisibleModals() {
        const modalSelectors = [
            '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]', 
            '[style*="position: fixed"]', '[style*="position: absolute"]',
            'div[class*="bn-"]', '[role="dialog"]',
            '[class*="overlay"]', '[class*="backdrop"]', '[class*="mask"]',
            '[class*="confirm"]', '[class*="alert"]', '[class*="notice"]',
            'div[style*="z-index"]', '[class*="bn-modal"]', '[class*="bn-dialog"]'
        ];
        const visible = [];
        for (const selector of modalSelectors) {
            const els = document.querySelectorAll(selector);
            for (const el of els) {
                const style = window.getComputedStyle(el);
                if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.offsetWidth > 50 && el.offsetHeight > 50) {
                    const zi = parseInt(style.zIndex || '0', 10) || 0;
                    visible.push({ el, z: zi, text: (el.textContent || '').trim() });
                }
            }
        }
        // 去重并按z-index降序
        const uniq = [];
        const seen = new Set();
        for (const m of visible.sort((a,b)=>b.z-a.z)) {
            if (!seen.has(m.el)) { seen.add(m.el); uniq.push(m); }
        }
        return uniq;
    }

    isDepositModalText(text) {
        if (!text) return false;
        const keys = ['充值', '存入', '划转', 'Add USDT', 'Add funds', 'Add balance', 'Top up', 'Deposit', '余额不足', '添加USDT余额', 'Insufficient balance', '添加USDT', 'USDT余额'];
        return keys.some(k => text.includes(k));
    }

    // 关闭多余的弹窗
    async closeExtraModals(modals) {
        if (modals.length <= 1) return;
        
        this.log(`开始关闭${modals.length - 1}个多余弹窗`, 'info');
        
        // 保留z-index最高的弹窗，关闭其他的
        const sortedModals = modals.sort((a, b) => b.z - a.z);
        const modalsToClose = sortedModals.slice(1); // 除了第一个（z-index最高的）
        
        for (let i = 0; i < modalsToClose.length; i++) {
            const modal = modalsToClose[i];
            try {
                await this.closeModalByElement(modal.el);
                this.log(`已关闭多余弹窗 ${i + 1}/${modalsToClose.length}`, 'info');
            } catch (error) {
                this.log(`关闭多余弹窗失败: ${error.message}`, 'warning');
            }
        }
    }

    // 关闭充值弹窗
    async closeDepositModal(modalElement) {
        this.log('尝试关闭充值弹窗', 'info');
        await this.closeModalByElement(modalElement);
    }

    // 处理现有弹窗
    async handleExistingModals(modals) {
        this.log(`开始处理 ${modals.length} 个现有弹窗`, 'info');
        
        for (let i = 0; i < modals.length; i++) {
            const modal = modals[i];
            const modalText = modal.text || '';
            
            // 检查是否是交易确认弹窗
            if (this.isTradeConfirmModalText && this.isTradeConfirmModalText(modalText)) {
                this.log(`处理交易确认弹窗 ${i + 1}/${modals.length}`, 'info');
                // 尝试点击确认按钮
                const confirmBtn = this.findBuyConfirmButton({ allowPageFallback: false });
                if (confirmBtn) {
                    confirmBtn.click();
                    await this.sleep(500);
                    continue;
                }
            }
            
            // 检查是否是充值弹窗
            if (this.isDepositModalText && this.isDepositModalText(modalText)) {
                this.log(`关闭充值弹窗 ${i + 1}/${modals.length}`, 'warning');
                await this.closeModalByElement(modal.el);
                continue;
            }
            
            // 其他弹窗，尝试关闭
            this.log(`关闭其他弹窗 ${i + 1}/${modals.length}`, 'info');
            await this.closeModalByElement(modal.el);
        }
    }

    // 通用关闭弹窗方法
    async closeModalByElement(modalElement) {
        if (!modalElement) return;
        
        // 方法1: 查找关闭按钮 (×, 取消, 关闭等)
        const closeButtons = modalElement.querySelectorAll('button, [role="button"]');
        for (const btn of closeButtons) {
            const btnText = (btn.textContent || '').trim();
            const btnClass = btn.className || '';
            
            // 检查是否是关闭按钮
            if (btnText.match(/^[×xX]$/) || 
                btnText.includes('取消') || 
                btnText.includes('关闭') || 
                btnText.includes('Cancel') || 
                btnText.includes('Close') ||
                btnClass.includes('close') ||
                btnClass.includes('cancel')) {
                
                this.log(`点击关闭按钮: "${btnText}"`, 'info');
                btn.click();
                await this.sleep(200);
                return;
            }
        }
        
        // 方法2: 查找遮罩层点击关闭
        const backdrop = modalElement.querySelector('.bn-mask, [class*="backdrop"], [class*="overlay"]');
        if (backdrop) {
            this.log('点击遮罩层关闭弹窗', 'info');
            backdrop.click();
            await this.sleep(200);
            return;
        }
        
        // 方法3: ESC键关闭
        this.log('尝试ESC键关闭弹窗', 'info');
        const escEvent = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(escEvent);
        await this.sleep(200);
    }

    isTradeConfirmModalText(text) {
        if (!text) return false;
        const mustHave = ['类型', '限价', '买入', '成交额'];
        const mentions = mustHave.filter(k => text.includes(k)).length;
        return mentions >= 2 && !this.isDepositModalText(text);
    }

    // 调试方法：分析页面中所有可能的弹窗元素
    debugAllModalElements() {
        this.log('=== 开始分析页面中的所有弹窗元素 ===', 'info');
        
        // 查找所有可能包含弹窗的元素
        const allPossibleModals = document.querySelectorAll('*');
        const modalCandidates = [];
        
        for (const el of allPossibleModals) {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            
            // 检查是否可能是弹窗
            const isPossibleModal = (
                // 位置检查
                (style.position === 'fixed' || style.position === 'absolute') &&
                // 尺寸检查
                rect.width > 100 && rect.height > 100 &&
                // 可见性检查
                style.display !== 'none' && 
                style.visibility !== 'hidden' && 
                style.opacity !== '0' &&
                // 内容检查
                el.textContent && el.textContent.length > 10
            );
            
            if (isPossibleModal) {
                modalCandidates.push({
                    element: el,
                    tagName: el.tagName,
                    className: el.className,
                    id: el.id,
                    textContent: el.textContent.substring(0, 100) + '...',
                    style: {
                        position: style.position,
                        zIndex: style.zIndex,
                        display: style.display,
                        visibility: style.visibility,
                        opacity: style.opacity
                    },
                    rect: {
                        width: rect.width,
                        height: rect.height,
                        top: rect.top,
                        left: rect.left
                    }
                });
            }
        }
        
        this.log(`找到 ${modalCandidates.length} 个可能的弹窗候选元素`, 'info');
        
        // 输出前5个最可能的弹窗
        modalCandidates.slice(0, 5).forEach((modal, index) => {
            this.log(`弹窗候选${index + 1}:`, 'info');
            this.log(`  标签: ${modal.tagName}`, 'info');
            this.log(`  类名: ${modal.className}`, 'info');
            this.log(`  ID: ${modal.id}`, 'info');
            this.log(`  位置: ${modal.style.position}, z-index: ${modal.style.zIndex}`, 'info');
            this.log(`  尺寸: ${modal.rect.width}x${modal.rect.height}`, 'info');
            this.log(`  内容: ${modal.textContent}`, 'info');
            
            // 检查是否包含确认按钮
            const buttons = modal.element.querySelectorAll('button');
            this.log(`  包含按钮数量: ${buttons.length}`, 'info');
            
            buttons.forEach((btn, btnIndex) => {
                const btnText = btn.textContent?.trim() || '';
                const btnClass = btn.className || '';
                this.log(`    按钮${btnIndex + 1}: "${btnText}" (${btnClass})`, 'info');
            });
        });
        
        this.log('=== 弹窗元素分析完成 ===', 'info');
    }

    // 增强的确认按钮查找方法
    findEnhancedConfirmButton() {
        this.log('开始增强的确认按钮查找...', 'info');
        
        // 查找所有按钮
        const allButtons = document.querySelectorAll('button');
        this.log(`页面中共找到 ${allButtons.length} 个按钮`, 'info');
        
        const confirmCandidates = [];
        
        for (const btn of allButtons) {
            const btnText = btn.textContent?.trim() || '';
            const btnClass = btn.className || '';
            const isVisible = this.isVisible(btn);
            const isDisabled = btn.disabled;
            const isDeposit = this.isDepositButton(btn);
            const inOrderForm = this.isInOrderForm(btn);
            
            // 检查是否可能是确认按钮
            const possibleConfirmTexts = [
                '确认', '继续', '下单', '提交', '买入', 'Confirm', 'Continue', 'Submit', 'Buy',
                '确定', 'OK', '是', 'Yes', '同意', 'Agree', '接受', 'Accept'
            ];
            
            const isConfirmText = possibleConfirmTexts.some(text => btnText.includes(text));
            
            // 检查按钮样式是否像确认按钮
            const isConfirmStyle = (
                btnClass.includes('primary') || 
                btnClass.includes('confirm') || 
                btnClass.includes('submit') ||
                btnClass.includes('bn-button__primary') ||
                btnClass.includes('w-full')
            );
            
            if (isConfirmText || isConfirmStyle) {
                confirmCandidates.push({
                    element: btn,
                    text: btnText,
                    className: btnClass,
                    isVisible: isVisible,
                    isDisabled: isDisabled,
                    isDeposit: isDeposit,
                    inOrderForm: inOrderForm,
                    isConfirmText: isConfirmText,
                    isConfirmStyle: isConfirmStyle
                });
            }
        }
        
        this.log(`找到 ${confirmCandidates.length} 个可能的确认按钮候选`, 'info');
        
        // 按优先级排序并选择最佳候选
        const sortedCandidates = confirmCandidates.sort((a, b) => {
            // 优先级：可见 > 非禁用 > 非充值 > 非交易面板内 > 确认文本 > 确认样式
            let scoreA = 0;
            let scoreB = 0;
            
            if (a.isVisible && !a.isDisabled && !a.isDeposit && !a.inOrderForm) scoreA += 100;
            if (b.isVisible && !b.isDisabled && !b.isDeposit && !b.inOrderForm) scoreB += 100;
            
            if (a.isConfirmText) scoreA += 50;
            if (b.isConfirmText) scoreB += 50;
            
            if (a.isConfirmStyle) scoreA += 25;
            if (b.isConfirmStyle) scoreB += 25;
            
            return scoreB - scoreA;
        });
        
        // 输出前3个最佳候选
        sortedCandidates.slice(0, 3).forEach((candidate, index) => {
            this.log(`确认按钮候选${index + 1}:`, 'info');
            this.log(`  文本: "${candidate.text}"`, 'info');
            this.log(`  类名: ${candidate.className}`, 'info');
            this.log(`  可见: ${candidate.isVisible}, 禁用: ${candidate.isDisabled}`, 'info');
            this.log(`  充值: ${candidate.isDeposit}, 交易面板内: ${candidate.inOrderForm}`, 'info');
            this.log(`  确认文本: ${candidate.isConfirmText}, 确认样式: ${candidate.isConfirmStyle}`, 'info');
        });
        
        // 返回最佳候选
        const bestCandidate = sortedCandidates.find(candidate => 
            candidate.isVisible && 
            !candidate.isDisabled && 
            !candidate.isDeposit && 
            !candidate.inOrderForm
        );
        
        if (bestCandidate) {
            this.log(`✅ 选择最佳确认按钮: "${bestCandidate.text}"`, 'success');
            return bestCandidate.element;
        }
        
        this.log('未找到合适的确认按钮候选', 'warning');
        return null;
    }

    findBuyConfirmButton(options = {}) {
        const { allowPageFallback = true } = options;
        this.log('开始查找买入确认按钮...', 'info');
        
        // 方法1: 根据Buy_Process.md，使用精确的确认按钮选择器
        // 文档中的确认按钮：<button class="bn-button bn-button__primary data-size-middle w-full mt-[16px] h-[48px]">确认</button>
        const exactConfirmButtons = document.querySelectorAll('button.bn-button.bn-button__primary.w-full[class*="mt-"]');
        for (const btn of exactConfirmButtons) {
            const btnText = (btn.textContent || '').trim();
            if (btnText === '确认' && this.isVisible(btn) && !btn.disabled) {
                this.log(`✅ 找到精确匹配的确认按钮: "${btnText}"`, 'success');
                return btn;
            }
        }

        // 方法2: 使用可见弹窗集合（按z-index排序）
        const visible = this.getVisibleModals ? this.getVisibleModals() : [];
        this.log(`找到 ${visible.length} 个可能的弹窗元素`, 'info');
        
        for (const { el: modal } of visible) {
            const modalText = modal.textContent || '';
            
            // 确保是交易确认弹窗，检查关键特征
            const hasTradeInfo = modalText.includes('限价') && modalText.includes('买入') && modalText.includes('成交额');
            const hasReverseOrder = modalText.includes('反向订单');
            
            if (hasTradeInfo && modalText.length > 100) {
                this.log(`发现交易确认弹窗，内容长度: ${modalText.length}`, 'info');
                
                // 在弹窗内查找确认按钮 - 使用更精确的选择器
                const confirmButtons = modal.querySelectorAll('button.bn-button.bn-button__primary.w-full');
                this.log(`弹窗中找到 ${confirmButtons.length} 个primary按钮`, 'info');
                
                for (const btn of confirmButtons) {
                    const btnText = (btn.textContent || '').trim();
                    const btnClass = btn.className || '';
                    
                    // 检查按钮高度和边距特征（根据文档：mt-[16px] h-[48px]）
                    const hasCorrectHeight = btnClass.includes('h-[48px]') || btn.style.height === '48px';
                    const hasCorrectMargin = btnClass.includes('mt-[16px]') || btnClass.includes('mt-');
                    
                    this.log(`按钮检查: 文本="${btnText}", 高度特征=${hasCorrectHeight}, 边距特征=${hasCorrectMargin}`, 'info');
                    
                    if (btnText === '确认' && this.isVisible(btn) && !btn.disabled) {
                        this.log(`✅ 找到弹窗内确认按钮: "${btnText}"`, 'success');
                        return btn;
                    }
                }
                
                // 如果没找到"确认"文本，查找符合样式特征的按钮
                for (const btn of confirmButtons) {
                    const btnText = (btn.textContent || '').trim();
                    if (!this.isDepositButton(btn) && !btn.disabled && this.isVisible(btn) && btnText) {
                        this.log(`✅ 使用弹窗内primary按钮: "${btnText}"`, 'info');
                        return btn;
                    }
                }
            }
        }
        
        // 方法3: 页面级别查找（作为备用）
        if (allowPageFallback) {
            this.log('在页面中查找确认按钮...', 'info');
            
            // 查找所有"确认"按钮
            const confirmButtons = Array.from(document.querySelectorAll('button'))
                .filter(btn => (btn.textContent || '').trim() === '确认');
                
            for (const btn of confirmButtons) {
                if (!this.isInOrderForm(btn) && !this.isDepositButton(btn) && !btn.disabled && this.isVisible(btn)) {
                    this.log(`✅ 在页面找到确认按钮: 类名=${btn.className}`, 'success');
                    return btn;
                }
            }
        }
        
        this.log('未找到符合条件的确认按钮', 'warning');
        return null;
    }

    async waitForBuyComplete() {
        this.currentState = 'monitoring_buy';
        this.log('等待买入订单完成...', 'info');

        return new Promise((resolve, reject) => {
            let checkCount = 0;
            const maxChecks = 120; // 最多检查2分钟
            
            this.orderCheckInterval = setInterval(async () => {
                checkCount++;
                
                if (!this.isRunning) {
                    clearInterval(this.orderCheckInterval);
                    resolve();
                    return;
                }

                if (checkCount > maxChecks) {
                    clearInterval(this.orderCheckInterval);
                    reject(new Error('买入订单等待超时'));
                    return;
                }

                try {
                    const isComplete = await this.checkBuyOrderComplete();
                    if (isComplete) {
                        clearInterval(this.orderCheckInterval);
                        this.log('买入订单完成', 'success');
                        resolve();
                    }
                } catch (error) {
                    this.log(`检查买入状态出错: ${error.message}`, 'error');
                }
            }, 1000);
        });
    }

    async checkBuyOrderComplete() {
        // 首先检查是否有买入委托记录存在
        const hasActiveBuyOrder = await this.checkActiveBuyOrder();
        
        if (!hasActiveBuyOrder) {
            // 如果没有活跃的买入委托，说明订单已经完成
            this.log('买入委托记录已消失，订单完成', 'success');
            return true;
        } else {
            // 如果还有活跃的买入委托，说明订单还在进行中
            this.log('买入委托仍在进行中...', 'info');
            return false;
        }
    }

    async checkActiveBuyOrder() {
        // 确保在当前委托选项卡
        await this.switchToCurrentOrders();
        
        // 查找当前委托表格中的买入订单
        const orderRows = this.getOrderTableRows();
        
        for (const row of orderRows) {
            const rowText = row.textContent;
            
            // 检查是否包含买入相关信息
            if (rowText.includes('买入') || rowText.includes('Buy')) {
                // 进一步检查订单状态
                const statusCell = row.querySelector('td[aria-colindex="7"]'); // 状态列
                if (statusCell) {
                    const status = statusCell.textContent.trim();
                    // 如果状态是"新订单"、"部分成交"等，说明订单还在进行
                    if (status.includes('新订单') || status.includes('部分成交') || 
                        status.includes('New') || status.includes('Partial')) {
                        this.log(`发现活跃买入订单，状态: ${status}`, 'info');
                        return true;
                    }
                }
            }
        }
        
        return false;
    }

    async switchToCurrentOrders() {
        // 切换到当前委托选项卡
        const currentOrderTab = document.querySelector('[data-tab-key="orderOrder"]') ||
                               document.querySelector('#bn-tab-orderOrder') ||
                               Array.from(document.querySelectorAll('[role="tab"]')).find(tab => 
                                   tab.textContent.includes('当前委托')
                               );
        
        if (currentOrderTab && !currentOrderTab.classList.contains('active')) {
            currentOrderTab.click();
            this.log('切换到当前委托选项卡', 'info');
        }
        
        // 确保在限价选项卡
        const limitTab = document.querySelector('[data-tab-key="limit"]') ||
                        document.querySelector('#bn-tab-limit') ||
                        Array.from(document.querySelectorAll('[role="tab"]')).find(tab => 
                            tab.textContent.includes('限价')
                        );
        
        if (limitTab && !limitTab.classList.contains('active')) {
            limitTab.click();
            this.log('切换到限价委托选项卡', 'info');
        }
    }

    getOrderTableRows() {
        // 查找委托表格中的数据行
        const tableBody = document.querySelector('.bn-web-table-tbody');
        if (!tableBody) {
            this.log('未找到委托表格', 'error');
            return [];
        }
        
        // 获取所有数据行，排除测量行
        const rows = Array.from(tableBody.querySelectorAll('tr')).filter(row => 
            !row.classList.contains('bn-web-table-measure-row') && 
            row.style.height !== '0px'
        );
        
        return rows;
    }

    async finalBuyConfirmation() {
        this.log('进行最终买入确认检查...', 'info');
        
        // 等待一段时间确保数据更新
        await this.sleep(500);
        
        // 只检查当前委托中是否还有买入订单
        const hasActiveBuyOrder = await this.checkActiveBuyOrder();
        if (hasActiveBuyOrder) {
            this.log('仍有活跃买入委托，买入未完成', 'error');
            return false;
        }
        
        this.log('最终确认：买入已成功完成（无活跃委托）', 'success');
        return true;
    }






    debugTabState() {
        const buyTab = document.querySelector('#bn-tab-0.bn-tab__buySell');
        
        if (buyTab) {
            const buySelected = buyTab.getAttribute('aria-selected');
            const buyActive = buyTab.classList.contains('active');
            this.log(`买入选项卡状态: aria-selected=${buySelected}, active=${buyActive}`, 'info');
        } else {
            this.log('未找到买入选项卡元素 (#bn-tab-0.bn-tab__buySell)', 'error');
        }
    }


    
















    clearLogs() {
        this.logContainer.innerHTML = '';
        this.log('日志已清空', 'info');
    }

    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logItem = document.createElement('div');
        logItem.className = `log-item ${type}`;
        logItem.textContent = `[${timestamp}] ${message}`;
        
        this.logContainer.appendChild(logItem);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;

        // 保持最多200条日志
        if (this.logContainer.children.length > 200) {
            this.logContainer.removeChild(this.logContainer.firstChild);
        }

        console.log(`[Binance Auto Trader] ${message}`);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // 倒计时功能
    startCountdown(seconds, message = '倒计时') {
        this.clearCountdown(); // 清除之前的倒计时

        if (!seconds || seconds <= 0) {
            return;
        }
        
        let remaining = Math.ceil(seconds);
        this.log(`⏰ ${message}: ${remaining}秒`, 'info');
        
        this.countdownInterval = setInterval(() => {
            remaining--;
            if (remaining > 0) {
                this.log(`⏰ ${message}: ${remaining}秒`, 'info');
            } else {
                this.log(`✅ ${message}完成`, 'success');
                this.clearCountdown();
            }
        }, 1000);
    }
    
    // 清除倒计时
    clearCountdown() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
    }

    // 获取UTC+0的当前日期字符串
    getUTCDateString() {
        const now = new Date();
        // 直接使用UTC时间，不需要时区转换
        const year = now.getUTCFullYear();
        const month = String(now.getUTCMonth() + 1).padStart(2, '0');
        const day = String(now.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`; // 格式: YYYY-MM-DD
    }

    // 加载每日统计数据
    async loadDailyStats() {
        try {
            const today = this.getUTCDateString();
            const storedData = await this.getStorageData('dailyStats');
            
            if (storedData && storedData.date === today) {
                this.dailyTradeCount = storedData.count || 0;
                this.lastTradeDate = storedData.date;
            } else {
                // 新的一天，重置计数
                this.dailyTradeCount = 0;
                this.lastTradeDate = today;
                await this.saveDailyStats();
            }
            
            this.updateDailyStatsDisplay();
            this.log(`今日交易次数: ${this.dailyTradeCount}`, 'info');
            } catch (error) {
            this.log(`加载每日统计失败: ${error.message}`, 'error');
            this.dailyTradeCount = 0;
            this.updateDailyStatsDisplay();
        }
    }

    // 保存每日统计数据
    async saveDailyStats() {
        try {
            const today = this.getUTCDateString();
            const data = {
                date: today,
                count: this.dailyTradeCount
            };
            await this.setStorageData('dailyStats', data);
                } catch (error) {
            this.log(`保存每日统计失败: ${error.message}`, 'error');
        }
    }

    // 增加今日交易次数
    async incrementDailyTradeCount() {
        const today = this.getUTCDateString();
        
        // 检查是否是新的一天
        if (this.lastTradeDate !== today) {
            this.dailyTradeCount = 0;
            this.lastTradeDate = today;
        }
        
        this.dailyTradeCount++;
        await this.saveDailyStats();
        this.updateDailyStatsDisplay();
        
        this.log(`今日交易次数更新: ${this.dailyTradeCount}`, 'info');
    }

    // 更新每日统计显示
    updateDailyStatsDisplay() {
        if (this.dailyStats) {
            this.dailyStats.textContent = `今日交易: ${this.dailyTradeCount}次`;
        }
    }

    // 获取本地存储数据
    async getStorageData(key) {
        return new Promise((resolve) => {
            chrome.storage.local.get([key], (result) => {
                resolve(result[key] || null);
            });
        });
    }

    // 设置本地存储数据
    async setStorageData(key, value) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [key]: value }, () => {
                resolve();
            });
        });
    }

    // 切换配置面板显示
    toggleConfigPanel() {
        const configPanel = document.getElementById('config-panel');
        const isVisible = configPanel.style.display !== 'none';
        
        if (isVisible) {
            configPanel.style.display = 'none';
            } else {
            configPanel.style.display = 'block';
            this.loadConfigToPanel();
        }
    }

    // 加载配置到配置面板
    loadConfigToPanel() {
        const configDelay = document.getElementById('config-delay');
        const configSellDiscount = document.getElementById('config-sell-discount');
        
        configDelay.value = typeof this.tradeDelay === 'number' ? this.tradeDelay : 2;
        configSellDiscount.value = (this.sellDiscountRate * 100) || 2;
        
        // 添加实时监听
        this.addConfigListeners();
    }
    
    // 添加配置面板实时监听
    addConfigListeners() {
        const configDelay = document.getElementById('config-delay');
        const configSellDiscount = document.getElementById('config-sell-discount');
        
        // 监听延迟时间变化
        if (configDelay) {
            configDelay.addEventListener('input', () => {
                const value = parseFloat(configDelay.value);
                if (!isNaN(value) && value >= 0) {
                    this.tradeDelay = value;
                    if (value === 0) {
                        this.log('延迟已关闭，将立即执行交易', 'info');
                    } else {
                        this.log(`延迟时间已更新为: ${value}秒`, 'info');
                    }
                }
            });
        }
        
        // 监听卖出折价率变化
        if (configSellDiscount) {
            configSellDiscount.addEventListener('input', () => {
                const value = parseFloat(configSellDiscount.value);
                if (!isNaN(value) && value >= 0 && value <= 10) {
                    this.sellDiscountRate = value / 100;
                    this.log(`卖出折价率已更新为: ${value}%`, 'info');
                }
            });
        }
    }

    // 保存配置
    async saveConfig() {
        const configDelay = parseFloat(document.getElementById('config-delay').value);
        const configSellDiscount = parseFloat(document.getElementById('config-sell-discount').value);
        
        if (isNaN(configDelay) || configDelay < 0) {
            this.log('延迟时间必须大于等于0秒', 'error');
            return;
        }
        
        if (isNaN(configSellDiscount) || configSellDiscount < 0 || configSellDiscount > 10) {
            this.log('卖出折价率必须在0-10%之间', 'error');
            return;
        }
        
        // 更新配置（仅处理延迟与卖出折价率）
        this.tradeDelay = configDelay;
        this.sellDiscountRate = configSellDiscount / 100; // 转换为小数
        
		// Persist only config fields; do not override amount/count here
		try {
			const prev = await this.getStorageData('userConfig') || {};
			await this.setStorageData('userConfig', {
				...prev,
				delay: configDelay,
				sellDiscountRate: this.sellDiscountRate
			});
		} catch (e) {
			this.log(`Persist config failed: ${e.message}`, 'error');
		}
        
        this.log(`配置已保存: 延迟=${configDelay}s, 折价率=${configSellDiscount}%`, 'success');
        
        // 隐藏配置面板
        document.getElementById('config-panel').style.display = 'none';
    }

    // 取消配置
    cancelConfig() {
        document.getElementById('config-panel').style.display = 'none';
    }

    // 加载用户配置
    async loadUserConfig() {
        try {
            const userConfig = await this.getStorageData('userConfig');
            if (userConfig) {
                this.currentAmount = userConfig.amount || 200;
                this.maxTradeCount = userConfig.count || 40;
                this.tradeDelay = typeof userConfig.delay === 'number' ? userConfig.delay : 2;
                
                // 加载智能交易配置
                this.smartTradingMode = userConfig.smartTradingMode || false;
                this.sellDiscountRate = userConfig.sellDiscountRate || 0.02;
                
                // 更新界面显示
                document.getElementById('trade-amount').value = this.currentAmount;
                document.getElementById('trade-count').value = this.maxTradeCount;
                this.updateSmartTradingSwitch();
                this.updateTradeCounter();
                
                this.log(`已加载用户配置: 金额=${this.currentAmount}U, 次数=${this.maxTradeCount}, 延迟=${this.tradeDelay}s, 智能交易=${this.smartTradingMode}`, 'info');
                    }
                } catch (error) {
            this.log(`加载用户配置失败: ${error.message}`, 'error');
        }
    }

	// 显式设置智能交易模式
	async setSmartTradingMode(enabled) {
        if (this.isRunning) {
            this.log('⚠️ Cannot toggle smart mode while running', 'warning');
            const switchEl = document.getElementById('smart-trading-switch');
            if (switchEl) switchEl.checked = this.smartTradingMode;
            return;
        }

        this.smartTradingMode = !!enabled;
        if (this.smartTradingMode) {
            this.log('智能交易模式已开启', 'info');
            this.startTrendAnalysis();
        } else {
            this.log('智能交易模式已关闭', 'info');
            this.stopTrendAnalysis();
            this.buyAmountRatio = 1.0;
        }

        this.updateSmartTradingSwitch();
        this.updateUI();

		// Persist only smartTradingMode; keep amount/count unchanged
		try {
			const prev = await this.getStorageData('userConfig') || {};
			await this.setStorageData('userConfig', {
				...prev,
				smartTradingMode: this.smartTradingMode
			});
		} catch (e) {
			this.log(`Persist smart mode failed: ${e.message}`, 'error');
		}
    }

    // 同步开关控件的UI文本与状态
    updateSmartTradingSwitch() {
        const switchEl = document.getElementById('smart-trading-switch');
        const stateEl = document.getElementById('smart-switch-state');
        if (switchEl) switchEl.checked = !!this.smartTradingMode;
        if (stateEl) {
            if (this.smartTradingMode) {
                stateEl.textContent = '开启';
                stateEl.classList.add('on');
            } else {
                stateEl.textContent = '关闭';
                stateEl.classList.remove('on');
            }
        }
    }

    // 开始趋势分析
    startTrendAnalysis() {
        if (this.trendAnalysisInterval) {
            clearInterval(this.trendAnalysisInterval);
        }
        
        this.trendAnalysisInterval = setInterval(async () => {
            await this.analyzeTrend();
        }, 2000); // 每2秒分析一次趋势
        
        this.log('趋势分析已启动', 'info');
    }

    // 停止趋势分析
    stopTrendAnalysis() {
        if (this.trendAnalysisInterval) {
            clearInterval(this.trendAnalysisInterval);
            this.trendAnalysisInterval = null;
        }
        this.log('趋势分析已停止', 'info');
    }

    // 检查是否可以开始买入
    checkBuyingPermission() {
        if (this.lastFallingSignalIndex >= 0) {
            const signalsSinceFalling = this.trendData.length - this.lastFallingSignalIndex;
            if (signalsSinceFalling >= this.fallingSignalWaitCount) {
                if (!this.canStartBuying) {
                    this.canStartBuying = true;
                    this.log(`✅ 已等待${this.fallingSignalWaitCount}个信号，可以重新开始买入`, 'success');
                }
            } else {
                const remaining = this.fallingSignalWaitCount - signalsSinceFalling;
                this.log(`⏳ 下降信号后等待中: ${signalsSinceFalling}/${this.fallingSignalWaitCount} (还需${remaining}个信号)`, 'info');
            }
        }
    }

    // 分析价格趋势
    async analyzeTrend() {
        try {
            // 获取成交记录数据
            const tradeRecords = this.getTradeRecords();
            if (tradeRecords.length < 5) {
                return; // 数据不足，无法分析趋势
            }

            // 提取价格数据
            const prices = tradeRecords.map(record => record.price);
            
            // 计算趋势
            const trend = this.calculateTrend(prices);
            this.previousTrend = this.currentTrend;
            this.currentTrend = trend;
            
            // 检测下降信号并记录索引
            if (trend === 'falling') {
                this.lastFallingSignalIndex = this.trendData.length;
                this.canStartBuying = false;
                this.log(`🚨 检测到下降信号，记录索引: ${this.lastFallingSignalIndex}，开始等待${this.fallingSignalWaitCount}个信号`, 'warning');
            }
            
            // 检查是否可以重新开始买入
            this.checkBuyingPermission();
            
            // 生成趋势数据字符串（模拟您提供的格式）
            const trendDataString = this.generateTrendDataString(trend, prices[0], tradeRecords.length);
            
            // 存储趋势数据
            this.storeTrendData(trendDataString, trend, prices[0]);
            
            // 更新连续信号计数
            this.updateConsecutiveSignals(trend);
            
            // 检查智能交易条件
            if (this.smartTradingMode && this.isRunning && this.sessionMode === 'smart') {
                this.checkSmartTradingConditions();
            }
            
            this.log(`趋势分析: ${trendDataString}`, 'info');
            
            // 智能交易模式下，在趋势分析之间添加延迟
            if (this.smartTradingMode && this.isRunning && this.sessionMode === 'smart') {
                const trendDelay = typeof this.tradeDelay === 'number' ? this.tradeDelay : 0;
                if (trendDelay > 0) {
                    const delayMs = trendDelay * 1000;
                    this.startCountdown(trendDelay, '趋势分析延迟');
                    await this.sleep(delayMs);
                }
            }
            
                } catch (error) {
            this.log(`趋势分析出错: ${error.message}`, 'error');
        }
    }

    // 生成趋势数据字符串
    generateTrendDataString(trend, currentPrice, recordCount) {
        const trendLabel = this.getTrendLabel(trend);
        const percentage = this.calculatePercentageChange(currentPrice);
        const vwapDeviation = this.calculateVWAPDeviation();
        const volumeDiff = this.calculateVolumeDifference();
        
        return `趋势: ${trendLabel} (${percentage.toFixed(2)}%) VWAP偏离 ${vwapDeviation.toFixed(2)}% · 量差 ${volumeDiff.toFixed(1)}% · n=${recordCount}`;
    }

    // 计算百分比变化
    calculatePercentageChange(currentPrice) {
        if (this.trendData.length === 0) return 0;
        const previousPrice = this.trendData[this.trendData.length - 1].price;
        return ((currentPrice - previousPrice) / previousPrice) * 100;
    }

    // 计算VWAP偏离（简化版本）
    calculateVWAPDeviation() {
        // 这里简化实现，实际应该基于成交量加权平均价格
        return Math.random() * 0.1 - 0.05; // 模拟-0.05%到0.05%的偏离
    }

    // 计算量差（简化版本）
    calculateVolumeDifference() {
        // 这里简化实现，实际应该基于成交量分析
        return Math.random() * 20 - 10; // 模拟-10%到10%的量差
    }

    // 存储趋势数据
    storeTrendData(trendString, trend, price) {
        const trendData = {
            timestamp: Date.now(),
            string: trendString,
            trend: trend,
            price: price
        };
        
        this.trendData.push(trendData);
        
        // 保持最多20条记录
        if (this.trendData.length > this.maxTrendDataCount) {
            this.trendData = this.trendData.slice(-this.maxTrendDataCount);
        }
    }

    // 更新连续信号计数
    updateConsecutiveSignals(trend) {
        if (trend === 'flat') {
            this.consecutiveFlatSignals++;
        } else {
            this.consecutiveFlatSignals = 0;
        }
    }

    // 获取成交记录数据
    getTradeRecords() {
        const tradeRecords = [];
        try {
            const container = document.querySelector('.ReactVirtualized__Grid__innerScrollContainer');
            if (!container) return tradeRecords;
            
            const rows = container.querySelectorAll('div[role="gridcell"]');
            rows.forEach(row => {
                const timeElement = row.querySelector('div:first-child');
                const priceElement = row.querySelector('div:nth-child(2)');
                const volumeElement = row.querySelector('div:last-child');
                
                if (timeElement && priceElement && volumeElement) {
                    const time = timeElement.textContent.trim();
                    const priceText = priceElement.textContent.trim();
                    const volume = volumeElement.textContent.trim();
                    
                    // 解析价格
                    const price = parseFloat(priceText);
                    if (!isNaN(price)) {
                        // 判断买入/卖出
                        const isBuy = priceElement.style.color.includes('Buy');
                        const isSell = priceElement.style.color.includes('Sell');
                        
                        tradeRecords.push({
                            time: time,
                            price: price,
                            volume: volume,
                            isBuy: isBuy,
                            isSell: isSell
                        });
                    }
                }
            });
        } catch (error) {
            this.log(`获取成交记录失败: ${error.message}`, 'error');
        }
        
        return tradeRecords;
    }

    // 计算趋势
    calculateTrend(prices, windowSize = 10) {
        if (prices.length < windowSize) {
            return 'unknown';
        }
        
        const recentPrices = prices.slice(0, windowSize);
        const oldestPrice = recentPrices[recentPrices.length - 1];
        const newestPrice = recentPrices[0];
        
        const priceChange = newestPrice - oldestPrice;
        const percentageChange = (priceChange / oldestPrice) * 100;
        
        // 趋势判断阈值
        const threshold = 0.1; // 0.1%
        
        if (percentageChange > threshold) {
            return 'rising';
        } else if (percentageChange < -threshold) {
            return 'falling';
                } else {
            return 'flat';
        }
    }

    // 获取趋势标签
    getTrendLabel(trend) {
        const labels = {
            'rising': '上涨',
            'falling': '下降',
            'flat': '平缓',
            'unknown': '未知'
        };
        return labels[trend] || '未知';
    }

    // 检查智能交易条件
    checkSmartTradingConditions() {
        if (!this.isRunning || this.sessionMode !== 'smart') return;
        if (!this.smartTradingMode) return;
        if (this.isSmartTradingExecution) return;

        if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
            this.log(`🛑 智能交易达到买入次数限制 (${this.currentTradeCount}/${this.maxTradeCount})，自动停止`, 'warning');
            this.stopTrading();
            return;
        }

        const recentSignals = this.getRecentSignals(3);
        if (recentSignals.length < 3) return;

        const ratio = this.shouldSmartStart(recentSignals);
        if (!ratio) return;

        this.buyAmountRatio = ratio;
        this.log(`智能交易触发买入，比例 ${(ratio * 100).toFixed(0)}% (信号: [${recentSignals.join(', ')}])`, 'info');
        this.executeSmartBuy();
    }

    // 执行智能交易单次买入
    async executeSmartBuy() {
        if (!this.isRunning || this.sessionMode !== 'smart') return;
        if (this.isSmartTradingExecution) return;
        
        // 达到买入次数上限的冗余保护
        if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
            this.log(`🛑 智能交易达到买入次数限制 (${this.currentTradeCount}/${this.maxTradeCount})，自动停止`, 'warning');
            this.stopTrading();
            return;
        }

        this.isSmartTradingExecution = true;

        try {
            this.log('🤖 智能交易开始买入', 'info');
            this.forceStop = false;

            let amount = parseFloat(document.getElementById('trade-amount').value);
            if (!amount || amount < 0.1) {
                this.log('请输入有效金额（≥0.1 USDT）', 'error');
                return;
            }

            if (this.buyAmountRatio !== 1.0) {
                const originalAmount = amount;
                amount = amount * this.buyAmountRatio;
                this.log(`智能交易金额调整: ${originalAmount} USDT × ${this.buyAmountRatio} = ${amount} USDT`, 'info');
            }

            this.log(`💰 交易金额: ${amount} USDT`, 'info');
            this.log(`🎯 智能交易买入比例: ${(this.buyAmountRatio * 100).toFixed(0)}%`, 'info');

            if (!this.performSafetyChecks()) {
                this.log('安全检查失败，取消买入', 'error');
                return;
            }

            this.currentAmount = amount;
            await this.executeBuy();

            await this.incrementDailyTradeCount();

            this.currentTradeCount++;
            this.updateTradeCounter();
            this.log('✅ 智能交易买入完成', 'success');

            if (this.maxTradeCount > 0 && this.currentTradeCount >= this.maxTradeCount) {
                this.log(`🛑 已达到买入次数限制 (${this.currentTradeCount}/${this.maxTradeCount})，自动停止`, 'warning');
                this.stopTrading();
                return;
            }

            const tradeDelay = typeof this.tradeDelay === 'number' ? this.tradeDelay : 0;
            if (tradeDelay > 0 && this.isRunning && this.sessionMode === 'smart') {
                const delayMs = tradeDelay * 1000;
                this.startCountdown(tradeDelay, '智能交易延迟');
                await this.sleep(delayMs);
            }
        } catch (error) {
            this.log(`智能交易买入失败: ${error.message}`, 'error');
        } finally {
            this.isSmartTradingExecution = false;
        }
    }

    // 判断是否应该智能开始
    shouldSmartStart(recentSignals) {
        if (!this.canStartBuying) {
            return null;
        }

        const [first, second, third] = recentSignals;

        // 100%买入条件：[平缓/上涨, 上涨, 上涨]
        if ((first === 'flat' || first === 'rising') && second === 'rising' && third === 'rising') {
            return 1.0;
        }

        // 50%买入条件：[平缓, 平缓, 平缓/上涨]
        if (first === 'flat' && second === 'flat' && (third === 'flat' || third === 'rising')) {
            return 0.5;
        }

        return null;
    }


    // 获取最近N个信号
    getRecentSignals(count) {
        // 取“最近”的N个信号：数组末尾是最新，返回按时间从早到晚的顺序
        const arr = this.trendData.slice(-count);
        return arr.map(data => data.trend);
    }

}

// 检查是否在币安Alpha交易页面
if (window.location.href.includes('binance.com/zh-CN/alpha/')) {
    // 等待页面加载完成
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => new BinanceAutoTrader(), 2000);
        });
    } else {
        setTimeout(() => new BinanceAutoTrader(), 2000);
    }
} else {
    console.log('Binance Auto Trader: 不在支持的页面');
}
