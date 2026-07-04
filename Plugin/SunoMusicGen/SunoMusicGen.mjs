#!/usr/bin/env node
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { promises as fsp } from 'fs';
import fs from 'fs';

// 获取当前目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载配置
dotenv.config({ path: path.join(__dirname, 'config.env') });

// API配置
const SUNO_API_KEYS_STR = process.env.SUNO_API_KEY;
const SUNO_API_BASE_URL = process.env.SUNO_API_BASE_URL || 'https://api.sunoapi.org';
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_MS || '30000', 10);
const MAX_POLLING_ATTEMPTS = parseInt(process.env.MAX_POLLING_ATTEMPTS || '60', 10);
const PLUGIN_NAME = 'SunoMusicGen';

// 缓存文件路径
const CACHE_FILE_PATH = path.join(__dirname, '.suno_api_cache.json');

// 检查API密钥
if (!SUNO_API_KEYS_STR) {
    console.log(JSON.stringify({ 
        status: 'error', 
        error: 'SUNO_API_KEY未配置，请在Plugin/SunoMusicGen/config.env中设置' 
    }));
    process.exit(1);
}

// 处理多个API Key
const SUNO_API_KEYS = SUNO_API_KEYS_STR.split(',').map(key => key.trim()).filter(key => key);

/**
 * ApiKeyPool - 管理API密钥池，实现顺序轮询和错误处理
 */
class ApiKeyPool {
    constructor(keys) {
        this.state = this.loadState();

        // 如果没有状态，或者环境变量中的密钥已更改，则重新初始化
        const envKeySet = new Set(keys);
        const stateKeySet = new Set(this.state.keys.map(k => k.key));

        if (this.state.keys.length !== keys.length || ![...envKeySet].every(k => stateKeySet.has(k))) {
            console.error(`[SunoMusicGen] 初始化API密钥池，共${keys.length}个密钥`);
            this.state = {
                currentIndex: 0,
                keys: keys.map(key => ({
                    key,
                    active: true,
                    errorCount: 0,
                    maxErrors: 3  // 降低为3次，因为音乐生成API比较昂贵
                }))
            };
            this.saveState();
        }
    }

    loadState() {
        try {
            if (fs.existsSync(CACHE_FILE_PATH)) {
                const data = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
                const state = JSON.parse(data);
                console.error(`[SunoMusicGen] 从缓存加载API密钥状态`);
                return state;
            }
        } catch (error) {
            console.error(`[SunoMusicGen] 无法读取缓存文件，使用新状态: ${error.message}`);
        }
        return { currentIndex: 0, keys: [] };
    }

    saveState() {
        try {
            fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(this.state, null, 2));
        } catch (error) {
            console.error(`[SunoMusicGen] 无法写入缓存文件: ${error.message}`);
        }
    }

    getNextKey() {
        const activeKeys = this.state.keys.filter(k => k.active);
        if (activeKeys.length === 0) {
            // 如果所有密钥都被禁用，尝试重置错误计数
            console.error(`[SunoMusicGen] 所有API密钥都已被禁用，尝试重置...`);
            this.resetAllKeys();
            const resetKeys = this.state.keys.filter(k => k.active);
            if (resetKeys.length === 0) {
                return null;
            }
        }

        // 使用模运算确保索引在有效范围内
        const activeIndex = this.state.currentIndex % activeKeys.length;
        const keyConfig = activeKeys[activeIndex];
        
        // 更新索引以指向下一个密钥
        this.state.currentIndex = (this.state.currentIndex + 1) % this.state.keys.length;
        
        console.error(`[SunoMusicGen] 使用API密钥 #${this.state.keys.indexOf(keyConfig) + 1}/${this.state.keys.length} (活跃: ${activeKeys.length}/${this.state.keys.length})`);
        
        this.saveState();
        return keyConfig;
    }

    markKeyError(key, errorType = 'general') {
        const keyConfig = this.state.keys.find(k => k.key === key);
        if (keyConfig) {
            keyConfig.errorCount++;
            keyConfig.lastError = new Date().toISOString();
            keyConfig.lastErrorType = errorType;
            
            console.error(`[SunoMusicGen] API密钥错误 (${errorType}): ${key.substring(0, 8)}... (错误次数: ${keyConfig.errorCount}/${keyConfig.maxErrors})`);
            
            if (keyConfig.errorCount >= keyConfig.maxErrors) {
                keyConfig.active = false;
                console.error(`[SunoMusicGen] 禁用API密钥 (多次错误): ${key.substring(0, 8)}...`);
            }
            
            this.saveState();
        }
    }

    markKeySuccess(key) {
        const keyConfig = this.state.keys.find(k => k.key === key);
        if (keyConfig) {
            // 成功后重置错误计数
            keyConfig.errorCount = 0;
            keyConfig.lastSuccess = new Date().toISOString();
            this.saveState();
        }
    }

    resetAllKeys() {
        console.error(`[SunoMusicGen] 重置所有API密钥状态`);
        this.state.keys.forEach(keyConfig => {
            if (keyConfig.errorCount < keyConfig.maxErrors * 2) {
                // 只重置错误次数不是特别多的密钥
                keyConfig.active = true;
                keyConfig.errorCount = Math.floor(keyConfig.errorCount / 2); // 减半错误计数
            }
        });
        this.saveState();
    }

    getAllKeysStatus() {
        return this.state.keys.map((k, index) => ({
            index: index + 1,
            active: k.active,
            errorCount: k.errorCount,
            lastError: k.lastError,
            lastSuccess: k.lastSuccess
        }));
    }
}

// 初始化API密钥池
const apiKeyPool = new ApiKeyPool(SUNO_API_KEYS);
console.error(`[SunoMusicGen] 已加载 ${SUNO_API_KEYS.length} 个API Key`);

// 创建axios实例
const apiClient = axios.create({
    baseURL: SUNO_API_BASE_URL,
    headers: {
        'Content-Type': 'application/json'
    }
});

// 添加请求拦截器，动态设置Authorization
apiClient.interceptors.request.use(config => {
    const keyConfig = apiKeyPool.getNextKey();
    if (!keyConfig) {
        throw new Error('没有可用的API密钥（所有密钥都已失效）');
    }
    
    // 保存当前使用的密钥到请求配置中，供响应拦截器使用
    config.currentApiKey = keyConfig.key;
    config.headers['Authorization'] = `Bearer ${keyConfig.key}`;
    return config;
});

// 添加响应拦截器，处理API限制错误
apiClient.interceptors.response.use(
    response => {
        // 请求成功，标记密钥成功
        if (response.config.currentApiKey) {
            apiKeyPool.markKeySuccess(response.config.currentApiKey);
        }
        return response;
    },
    async error => {
        const apiKey = error.config?.currentApiKey;
        
        // 如果是429（积分不足）或430（频率过高）
        if (error.response && (error.response.status === 429 || error.response.status === 430)) {
            if (apiKey) {
                console.error(`[SunoMusicGen] API Key限制错误 (${error.response.status})`);
                apiKeyPool.markKeyError(apiKey, 'quota_exceeded');
                
                // 如果还有其他可用密钥，尝试重试
                const retryKeyConfig = apiKeyPool.getNextKey();
                if (retryKeyConfig && retryKeyConfig.key !== apiKey) {
                    console.error(`[SunoMusicGen] 尝试使用下一个密钥重试请求`);
                    error.config.currentApiKey = retryKeyConfig.key;
                    error.config.headers['Authorization'] = `Bearer ${retryKeyConfig.key}`;
                    return apiClient.request(error.config);
                }
            }
        } else if (error.response && error.response.status === 401) {
            // 认证错误
            if (apiKey) {
                apiKeyPool.markKeyError(apiKey, 'auth_failed');
            }
        } else if (error.response && error.response.status >= 500) {
            // 服务器错误
            if (apiKey) {
                apiKeyPool.markKeyError(apiKey, 'server_error');
            }
        }
        
        return Promise.reject(error);
    }
);

// 下载音频文件到本地
async function downloadAudio(url, title, taskId) {
    try {
        const musicDir = path.resolve(__dirname, '..', '..', 'file', 'music');
        await fsp.mkdir(musicDir, { recursive: true });

        // 清理文件名
        const safeTitle = (title || `suno_music_${taskId}`)
            .replace(/[^a-z0-9\u4e00-\u9fa5\-_.]/gi, '_')
            .replace(/ /g, '_')
            .substring(0, 100);
        
        const filename = `${safeTitle}_${Date.now()}.mp3`;
        const filepath = path.join(musicDir, filename);

        // 下载文件
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'arraybuffer',
            timeout: 60000
        });

        await fsp.writeFile(filepath, response.data);
        console.error(`[SunoMusicGen] 音频已下载: ${filepath}`);
        return filepath;
    } catch (error) {
        console.error(`[SunoMusicGen] 下载失败: ${error.message}`);
        return null;
    }
}

// 后台轮询和回调
async function pollAndCallback(taskId, callbackUrl) {
    console.error(`[SunoMusicGen] 开始后台轮询任务: ${taskId}`);
    
    // 初始等待
    await new Promise(resolve => setTimeout(resolve, 30000)); // 等待30秒
    
    for (let attempt = 0; attempt < MAX_POLLING_ATTEMPTS; attempt++) {
        try {
            console.error(`[SunoMusicGen] 轮询尝试 ${attempt + 1}/${MAX_POLLING_ATTEMPTS}`);
            
            const statusResponse = await apiClient.get('/api/v1/generate/record-info', {
                params: { taskId }
            });

            if (statusResponse.data.code !== 200) {
                console.error(`[SunoMusicGen] 查询失败: ${statusResponse.data.msg}`);
                await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
                continue;
            }

            const taskData = statusResponse.data.data;
            const status = taskData.status;

            if (status === 'SUCCESS') {
                console.error(`[SunoMusicGen] 任务成功完成`);
                console.error(`[SunoMusicGen] 完整响应数据:`, JSON.stringify(taskData, null, 2));
                
                // 根据API文档，数据在 response.sunoData 数组中
                let audioDataArray = [];
                if (taskData.response && taskData.response.sunoData && Array.isArray(taskData.response.sunoData)) {
                    audioDataArray = taskData.response.sunoData;
                } else if (taskData.response && taskData.response.data && Array.isArray(taskData.response.data)) {
                    audioDataArray = taskData.response.data;
                } else if (taskData.data && Array.isArray(taskData.data)) {
                    audioDataArray = taskData.data;
                }
                
                if (audioDataArray.length === 0) {
                    console.error(`[SunoMusicGen] 无法找到音频数据，taskData结构:`, taskData);
                    // 回调失败
                    await sendCallback(callbackUrl, taskId, 'FAILED', null, '生成成功但没有返回音频数据');
                    return;
                }
                
                const audioData = audioDataArray[0];
                
                // 根据API文档，音频URL字段是 audioUrl，不是 audio_url
                const audioUrl = audioData.audioUrl || audioData.audio_url;
                const imageUrl = audioData.imageUrl || audioData.image_url;
                
                // 开始下载音频
                if (audioUrl) {
                    console.error(`[SunoMusicGen] 准备下载音频: ${audioUrl}`);
                    const downloadPath = await downloadAudio(audioUrl, audioData.title, taskId);
                    if (downloadPath) {
                        console.error(`[SunoMusicGen] 音频下载成功: ${downloadPath}`);
                    } else {
                        console.error(`[SunoMusicGen] 音频下载失败`);
                    }
                }
                
                // 构建成功消息
                let message = `🎵 音乐生成成功！\n`;
                message += `\n标题: ${audioData.title || '未命名'}`;
                if (audioData.tags) {
                    message += `\n风格: ${audioData.tags}`;
                }
                message += `\n时长: ${audioData.duration ? Math.round(audioData.duration) + '秒' : '未知'}`;
                message += `\n\n音频链接: ${audioUrl}`;
                
                if (imageUrl) {
                    message += `\n封面图片: ${imageUrl}`;
                }
                
                // 添加API密钥状态信息
                const keysStatus = apiKeyPool.getAllKeysStatus();
                const activeKeys = keysStatus.filter(k => k.active).length;
                message += `\n\n🔑 API密钥状态: ${activeKeys}/${keysStatus.length} 活跃`;
                
                // 如果有多个版本
                const otherVersions = [];
                for (let i = 1; i < audioDataArray.length && i < 3; i++) {
                    if (audioDataArray[i].audio_url) {
                        otherVersions.push(audioDataArray[i].audio_url);
                    }
                }
                
                // 发送成功回调
                await sendCallback(callbackUrl, taskId, 'SUCCESS', {
                    audioUrl: audioUrl,
                    title: audioData.title,
                    tags: audioData.tags,
                    duration: audioData.duration,
                    imageUrl: imageUrl,
                    otherVersions: otherVersions,
                    message: message
                });
                
                return;
                
            } else if (status === 'FAILED') {
                console.error(`[SunoMusicGen] 任务失败`);
                await sendCallback(callbackUrl, taskId, 'FAILED', null, taskData.errorMessage || '未知原因');
                return;
                
            } else if (status === 'GENERATING' || status === 'PENDING') {
                console.error(`[SunoMusicGen] 任务状态: ${status}`);
                // 继续轮询
            } else {
                console.error(`[SunoMusicGen] 未知状态: ${status}`);
            }
            
        } catch (error) {
            console.error(`[SunoMusicGen] 轮询出错: ${error.message}`);
        }
        
        // 等待下次轮询
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }
    
    // 超时
    console.error(`[SunoMusicGen] 轮询超时`);
    await sendCallback(callbackUrl, taskId, 'TIMEOUT', null, '任务轮询超时');
}

// 发送回调
async function sendCallback(callbackUrl, taskId, status, data, errorMessage) {
    try {
        const payload = {
            requestId: taskId,
            status: status,
            pluginName: PLUGIN_NAME
        };
        
        if (status === 'SUCCESS' && data) {
            payload.audioUrl = data.audioUrl;
            payload.message = data.message;
            payload.data = data;
        } else if (status === 'FAILED' || status === 'TIMEOUT') {
            payload.reason = errorMessage;
            payload.message = `音乐生成任务 (ID: ${taskId}) 失败: ${errorMessage}`;
        }
        
        const fullCallbackUrl = `${callbackUrl}/${PLUGIN_NAME}/${taskId}`;
        console.error(`[SunoMusicGen] 发送回调到: ${fullCallbackUrl}`);
        
        const response = await axios.post(fullCallbackUrl, payload, {
            timeout: 30000
        });
        
        console.error(`[SunoMusicGen] 回调成功: ${response.status}`);
    } catch (error) {
        console.error(`[SunoMusicGen] 回调失败: ${error.message}`);
    }
}

// 提交音乐生成任务
async function submitMusic(args) {
    try {
        // 构建请求payload
        const payload = {
            model: args.model || 'V4',
            instrumental: args.instrumental === 'true' || args.instrumental === true || false,
            callBackUrl: process.env.CALLBACK_URL || 'https://webhook.site/unique-id'
        };

        // 判断模式
        if (args.customMode === 'true' || args.customMode === true) {
            // 自定义模式
            if (!args.prompt || !args.style || !args.title) {
                throw new Error('自定义模式需要提供prompt(歌词)、style(风格)和title(标题)');
            }
            payload.customMode = true;
            payload.prompt = args.prompt;
            payload.style = args.style;
            payload.title = args.title;
        } else {
            // 描述模式
            if (!args.prompt) {
                throw new Error('请提供音乐描述(prompt)');
            }
            payload.customMode = false;
            payload.prompt = args.prompt;
        }

        // 提交生成任务
        const submitResponse = await apiClient.post('/api/v1/generate', payload);
        
        if (submitResponse.data.code !== 200) {
            throw new Error(`API错误: ${submitResponse.data.msg || '未知错误'}`);
        }

        const taskId = submitResponse.data.data.taskId;
        console.error(`[SunoMusicGen] 任务已提交: ${taskId}`);
        
        // 获取回调URL
        const callbackUrl = process.env.CALLBACK_BASE_URL;
        console.error(`[SunoMusicGen] 环境变量 CALLBACK_BASE_URL: ${callbackUrl || '未设置'}`);
        console.error(`[SunoMusicGen] 所有环境变量:`, Object.keys(process.env).filter(k => k.includes('CALLBACK') || k.includes('PLUGIN')));
        
        if (callbackUrl) {
            console.error(`[SunoMusicGen] 准备启动后台轮询，回调URL: ${callbackUrl}`);
            // 启动后台轮询线程
            const pollPromise = pollAndCallback(taskId, callbackUrl);
            
            pollPromise.then(() => {
                console.error(`[SunoMusicGen] 后台轮询完成，准备退出`);
                process.exit(0);
            }).catch(err => {
                console.error(`[SunoMusicGen] 后台轮询错误: ${err.message}`);
                process.exit(1);
            });
            
            console.error(`[SunoMusicGen] 后台轮询已启动`);
        } else {
            console.error(`[SunoMusicGen] 未配置CALLBACK_BASE_URL，不会进行后台轮询`);
        }
        
        // 返回占位符，并包含API密钥状态
        const keysStatus = apiKeyPool.getAllKeysStatus();
        const activeKeys = keysStatus.filter(k => k.active).length;
        
        const resultMessage = `🎵 音乐生成任务 (ID: ${taskId}) 已成功提交！\n\n` +
                            `⏳ 生成过程通常需要1-3分钟，请耐心等待...\n` +
                            `🔑 API密钥状态: ${activeKeys}/${keysStatus.length} 活跃\n\n` +
                            `这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n` +
                            `请在你的回复中包含以下占位符原文：{{VCP_ASYNC_RESULT::SunoMusicGen::${taskId}}}`;
        
        return resultMessage;

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.msg || error.message;
            throw new Error(`API错误 (${status}): ${message}`);
        }
        throw error;
    }
}

// 延长音乐
async function extendMusic(args) {
    try {
        // 检查必需参数
        if (!args.audioId) {
            throw new Error('请提供要延长的音频ID(audioId)');
        }
        if (args.defaultParamFlag === undefined) {
            throw new Error('请指定defaultParamFlag(true/false)');
        }
        if (!args.model) {
            throw new Error('请指定模型版本(model)，需与原音频一致');
        }

        // 构建请求payload
        const payload = {
            defaultParamFlag: args.defaultParamFlag === 'true' || args.defaultParamFlag === true,
            audioId: args.audioId,
            model: args.model,
            callBackUrl: process.env.CALLBACK_URL || 'https://webhook.site/unique-id'
        };

        // 如果使用自定义参数
        if (payload.defaultParamFlag) {
            // 自定义参数模式必需字段
            if (!args.continueAt) {
                throw new Error('自定义模式需要提供continueAt(开始延长的时间点，秒)');
            }
            if (!args.prompt) {
                throw new Error('自定义模式需要提供prompt(描述如何延长)');
            }
            if (!args.style) {
                throw new Error('自定义模式需要提供style(音乐风格)');
            }
            if (!args.title) {
                throw new Error('自定义模式需要提供title(延长版标题)');
            }
            
            payload.continueAt = parseFloat(args.continueAt);
            payload.prompt = args.prompt;
            payload.style = args.style;
            payload.title = args.title;
            
            // 可选参数
            if (args.negativeTags) payload.negativeTags = args.negativeTags;
            if (args.vocalGender) payload.vocalGender = args.vocalGender;
            if (args.styleWeight) payload.styleWeight = parseFloat(args.styleWeight);
            if (args.weirdnessConstraint) payload.weirdnessConstraint = parseFloat(args.weirdnessConstraint);
            if (args.audioWeight) payload.audioWeight = parseFloat(args.audioWeight);
        }
        // 如果使用原始参数，不需要额外参数

        // 提交延长任务
        const submitResponse = await apiClient.post('/api/v1/generate/extend', payload);
        
        if (submitResponse.data.code !== 200) {
            throw new Error(`API错误: ${submitResponse.data.msg || '未知错误'}`);
        }

        const taskId = submitResponse.data.data.taskId;
        console.error(`[SunoMusicGen] 延长任务已提交: ${taskId}`);
        
        // 获取回调URL
        const callbackUrl = process.env.CALLBACK_BASE_URL;
        
        if (callbackUrl) {
            console.error(`[SunoMusicGen] 准备启动后台轮询，回调URL: ${callbackUrl}`);
            // 启动后台轮询线程
            const pollPromise = pollAndCallback(taskId, callbackUrl);
            
            pollPromise.then(() => {
                console.error(`[SunoMusicGen] 后台轮询完成，准备退出`);
                process.exit(0);
            }).catch(err => {
                console.error(`[SunoMusicGen] 后台轮询错误: ${err.message}`);
                process.exit(1);
            });
            
            console.error(`[SunoMusicGen] 后台轮询已启动`);
        }
        
        // 返回占位符，并包含API密钥状态
        const keysStatus = apiKeyPool.getAllKeysStatus();
        const activeKeys = keysStatus.filter(k => k.active).length;
        
        const resultMessage = `🎵 音乐延长任务 (ID: ${taskId}) 已成功提交！\n\n` +
                            `⏳ 延长过程通常需要1-3分钟，请耐心等待...\n` +
                            `🔑 API密钥状态: ${activeKeys}/${keysStatus.length} 活跃\n\n` +
                            `这是一个动态上下文占位符，当任务完成时，它会被自动替换为实际结果。\n` +
                            `请在你的回复中包含以下占位符原文：{{VCP_ASYNC_RESULT::SunoMusicGen::${taskId}}}`;
        
        return resultMessage;

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.msg || error.message;
            throw new Error(`API错误 (${status}): ${message}`);
        }
        throw error;
    }
}

// 查询任务状态
async function queryTask(args) {
    try {
        if (!args.taskId) {
            throw new Error('请提供任务ID(taskId)');
        }

        const statusResponse = await apiClient.get('/api/v1/generate/record-info', {
            params: { taskId: args.taskId }
        });

        if (statusResponse.data.code !== 200) {
            throw new Error(`查询失败: ${statusResponse.data.msg || '未知错误'}`);
        }

        const taskData = statusResponse.data.data;
        const status = taskData.status;
        
        let message = `📊 任务状态查询 (ID: ${args.taskId})\n\n`;
        message += `状态: ${status}\n\n`;
        
        if (status === 'SUCCESS') {
            // 根据API文档，数据在 response.sunoData 数组中
            let audioDataArray = [];
            if (taskData.response && taskData.response.sunoData && Array.isArray(taskData.response.sunoData)) {
                audioDataArray = taskData.response.sunoData;
            } else if (taskData.response && taskData.response.data && Array.isArray(taskData.response.data)) {
                audioDataArray = taskData.response.data;
            } else if (taskData.data && Array.isArray(taskData.data)) {
                audioDataArray = taskData.data;
            }
            
            if (audioDataArray.length > 0) {
                const audioData = audioDataArray[0];
                // 根据API文档，字段名是 audioUrl 而不是 audio_url
                const audioUrl = audioData.audioUrl || audioData.audio_url;
                
                message += `✅ 音乐已生成！\n`;
                message += `标题: ${audioData.title || '未命名'}\n`;
                message += `音频链接: ${audioUrl}\n`;
                
                // 开始下载
                if (audioUrl) {
                    console.error(`[SunoMusicGen] 准备下载音频: ${audioUrl}`);
                    const downloadPath = await downloadAudio(audioUrl, audioData.title, args.taskId);
                    if (downloadPath) {
                        message += `\n✅ 文件已下载: ${downloadPath}`;
                    } else {
                        message += `\n⚠️ 文件下载失败，但音频链接有效`;
                    }
                }
            }
        } else if (status === 'FAILED') {
            message += `❌ 生成失败\n`;
            message += `原因: ${taskData.errorMessage || '未知'}\n`;
        } else if (status === 'GENERATING' || status === 'PENDING') {
            message += `⏳ 正在生成中，请稍后再查询...\n`;
        }
        
        // 添加API密钥状态信息
        const keysStatus = apiKeyPool.getAllKeysStatus();
        const activeKeys = keysStatus.filter(k => k.active).length;
        message += `\n🔑 API密钥状态: ${activeKeys}/${keysStatus.length} 活跃`;
        
        return message;
        
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const message = error.response?.data?.msg || error.message;
            throw new Error(`API错误 (${status}): ${message}`);
        }
        throw error;
    }
}

// 主函数
async function main() {
    let inputJsonString = '';
    process.stdin.setEncoding('utf8');

    // 读取标准输入
    for await (const chunk of process.stdin) {
        inputJsonString += chunk;
    }

    try {
        if (!inputJsonString) {
            throw new Error('没有接收到输入');
        }

        const args = JSON.parse(inputJsonString);
        const command = args.command;

        let result;

        // 根据命令分发处理
        switch (command) {
            case 'submit':
                result = await submitMusic(args);
                break;
            
            case 'extend':
                result = await extendMusic(args);
                break;
            
            case 'query':
                result = await queryTask(args);
                break;
            
            default:
                throw new Error(`未知命令: ${command || '空命令'}`);
        }

        // 输出成功结果
        console.log(JSON.stringify({
            status: 'success',
            result: result
        }));
        
        // 异步插件：对于submit和extend命令，不要立即退出，让后台轮询运行
        if (command === 'submit' || command === 'extend') {
            // 不调用 process.exit()，让进程继续运行
            // 后台轮询会在完成或超时后自然结束
            console.error(`[SunoMusicGen] 主线程完成，后台轮询继续运行...`);
            
            // 设置一个安全的最大运行时间（10分钟）
            setTimeout(() => {
                console.error(`[SunoMusicGen] 达到最大运行时间，进程退出`);
                process.exit(0);
            }, 600000); // 10分钟
        } else {
            // 对于query命令，可以立即退出
            process.exit(0);
        }

    } catch (error) {
        // 输出错误
        console.log(JSON.stringify({
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
        }));
        process.exit(1);
    }
}

// 执行主函数
main();
