/* HLS 播放器封装：清晰度、倍速、音量、画面比例、画中画、失败回调、连播 */
const Q_KEY = 'ah:quality';
const RATE_KEY = 'ah:rate';
const VOL_KEY = 'ah:vol';
const FIT_KEY = 'ah:fit';

export const RATE_LIST = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
export const FIT_LIST = [
  { id: 'contain', label: '原始比例' },
  { id: 'cover', label: '裁切填满' },
  { id: 'fill', label: '拉伸填满' },
];

function read(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : v;
  } catch {
    return d;
  }
}

function write(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

export function mountPlayer(video, { stage, nextBox, onEnded, onProgress } = {}) {
  let hls = null;
  let watchdog = null;
  let cdTimer = null;
  let recovered = 0;
  let lastReport = 0;
  let stateCb = null;

  let pref = read(Q_KEY, 'auto');
  let rate = Number(read(RATE_KEY, '1')) || 1;
  const savedVol = read(VOL_KEY, '');
  let volume = savedVol === '' ? 1 : Math.min(1, Math.max(0, Number(savedVol)));
  let fit = FIT_LIST.some((f) => f.id === read(FIT_KEY, '')) ? read(FIT_KEY, 'contain') : 'contain';

  /** 手机上 video.volume 拿不到系统音量，滑块没意义 */
  const canVolume = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const canPip = typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled);

  function clearWatchdog() {
    clearTimeout(watchdog);
    watchdog = null;
  }

  function destroyHls() {
    if (hls) {
      try {
        hls.destroy();
      } catch {}
      hls = null;
    }
    clearWatchdog();
  }

  function pauseAll() {
    try {
      video.pause();
    } catch {}
    try {
      video.removeAttribute('src');
      video.load();
    } catch {}
    destroyHls();
  }

  /** 把 hls 档位 + 播放参数整理成 UI 能直接用的形状 */
  function snapshot() {
    const base = {
      rate,
      volume,
      muted: Boolean(video.muted),
      fit,
      playing: !video.paused && !video.ended,
      pip: Boolean(document.pictureInPictureElement),
      canVolume,
      canPip,
    };
    if (!hls) return { ...base, levels: [], current: -1, auto: true, pref };
    const ls = (hls.levels || []).map((l, i) => ({
      i,
      width: l.width || 0,
      height: l.height || 0,
      bitrate: l.bitrate || 0,
      name: l.name || '',
    }));
    return {
      ...base,
      levels: ls,
      current: hls.autoLevelEnabled ? -1 : hls.currentLevel,
      auto: hls.autoLevelEnabled,
      pref,
    };
  }

  function emit() {
    if (stateCb) stateCb(snapshot());
  }

  /** 按保存的偏好挑一个档位；找不到就退回自动 */
  function applyPref() {
    if (!hls || !hls.levels || !hls.levels.length) return;
    if (pref === 'auto') {
      hls.currentLevel = -1;
      return;
    }
    const want = Number(pref) || 0;
    if (!want) {
      hls.currentLevel = -1;
      return;
    }
    let pick = -1;
    for (let i = 0; i < hls.levels.length; i += 1) {
      const h = hls.levels[i].height || 0;
      if (h && h <= want && (pick < 0 || h > (hls.levels[pick].height || 0))) pick = i;
    }
    if (pick < 0) pick = hls.levels.length - 1;
    hls.currentLevel = pick;
  }

  /** 倍速、音量、画面比例：新建的 video 元素每次都要重新套一遍 */
  function applyPlayback() {
    try {
      video.playbackRate = rate;
      if (canVolume) video.volume = volume;
      video.style.objectFit = fit;
    } catch {}
  }

  async function load(url, { onFatal } = {}) {
    pauseAll();
    video.removeAttribute('src');
    video.load();
    recovered = 0;
    applyPlayback();

    // hls.js 是按需加载的，进到这里时页面已经把它拉下来了
    const Hls = window.Hls;
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');

    if (!Hls || !Hls.isSupported()) {
      if (!nativeHls) throw new Error('当前浏览器不支持 HLS 播放');
      video.src = url;
      video.load();
      applyPlayback();
      emit();
      return;
    }

    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // 缓存窗口压小一点：本地部署更省内存，拖动也不会重新拉太多
      backBufferLength: 30,
      maxBufferLength: 20,
      maxMaxBufferLength: 40,
      manifestLoadingTimeOut: 12000,
      manifestLoadingMaxRetry: 2,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 3,
      startLevel: -1,
    });

    hls.on(Hls.Events.ERROR, (_ev, data) => {
      if (!data.fatal) return;
      console.warn('[hls] fatal', data.type, data.details);
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 2) {
        recovered++;
        try {
          hls.recoverMediaError();
          return;
        } catch {}
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered < 3) {
        recovered++;
        try {
          hls.startLoad();
          return;
        } catch {}
      }
      onFatal?.(data);
    });

    hls.loadSource(url);
    window.__hls = hls; // 调试出口：控制台能直接看档位
    hls.attachMedia(video);

    // 看门狗：12s 内没有解析出分片就判为失败
    clearWatchdog();
    watchdog = setTimeout(() => {
      if (!hls) return;
      if (!hls.levels || hls.levels.length === 0) {
        onFatal?.({ type: 'TIMEOUT', details: 'manifest timeout' });
      }
    }, 12000);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      clearWatchdog();
      applyPref();
      applyPlayback();
      emit();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, () => emit());
  }

  function setLevel(i) {
    if (!hls) return;
    if (i < 0) {
      pref = 'auto';
      hls.currentLevel = -1;
    } else {
      const lv = hls.levels?.[i];
      pref = lv && lv.height ? String(lv.height) : String(i);
      hls.currentLevel = i;
    }
    writePref(pref);
    emit();
  }

  function writePref(v) {
    write(Q_KEY, v);
  }

  /** 用户设定倍速：记住，下次进任意一集都沿用 */
  function setRate(r) {
    rate = Math.min(3, Math.max(0.5, Number(r) || 1));
    write(RATE_KEY, String(rate));
    applyPlayback();
    emit();
  }

  /** 长按加速用的临时倍速，松手回到用户设定值，不落盘 */
  function holdRate(r) {
    try {
      video.playbackRate = r ? Number(r) : rate;
    } catch {}
    emit();
  }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, Number(v)));
    video.muted = volume === 0;
    write(VOL_KEY, String(volume));
    applyPlayback();
    emit();
  }

  function toggleMute() {
    video.muted = !video.muted;
    if (!video.muted && volume === 0) {
      volume = 1;
      applyPlayback();
    }
    emit();
  }

  function setFit(m) {
    fit = FIT_LIST.some((f) => f.id === m) ? m : 'contain';
    write(FIT_KEY, fit);
    applyPlayback();
    emit();
  }

  async function togglePip() {
    if (!canPip) return false;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return false;
      }
      await video.requestPictureInPicture();
      return true;
    } catch {
      return Boolean(document.pictureInPictureElement);
    }
  }

  // iOS Safari 没有 requestFullscreen，只有 video 上的私有方法。
  // 走原生全屏其实更好：系统播放器自带进度条、音量、投屏和画中画按钮。
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function toggleFullscreen() {
    const target = stage || video.parentElement || video;

    // iOS 分支
    if (isIOS) {
      if (video.webkitDisplayingFullscreen) {
        video.webkitExitFullscreen?.();
      } else if (video.webkitEnterFullscreen) {
        try {
          video.webkitEnterFullscreen();
        } catch {}
      }
      return;
    }

    if (!document.fullscreenElement) {
      const p = target.requestFullscreen?.();
      if (p && p.catch) p.catch(() => {});
    } else {
      const p = document.exitFullscreen?.();
      if (p && p.catch) p.catch(() => {});
    }
  }

  // iOS 原生全屏进出走的是自己的一套事件
  video.addEventListener('webkitbeginfullscreen', () => {
    document.body.classList.add('is-fs');
    emit();
  });
  video.addEventListener('webkitendfullscreen', () => {
    document.body.classList.remove('is-fs');
    emit();
  });

  // 全屏时隐藏底部 tab，退出后恢复
  document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('is-fs', Boolean(document.fullscreenElement));
    emit();
  });

  /** 相对跳转（键盘 ←→），夹在 [0, duration-0.3] 内，避免卡在末尾 */
  function nudge(delta) {
    const d = Number(video.duration);
    const upper = Number.isFinite(d) && d > 0 ? Math.max(0, d - 0.3) : Number.POSITIVE_INFINITY;
    const to = Math.min(upper, Math.max(0, video.currentTime + delta));
    try {
      video.currentTime = to;
    } catch {}
    report();
    return to;
  }

  function countdown(sec, cb) {
    clearInterval(cdTimer);
    let left = sec;
    const label = nextBox && nextBox.querySelector('span');
    const tick = () => {
      if (label) label.textContent = `即将播放：下一集（${left}s）`;
      if (left-- <= 0) {
        clearInterval(cdTimer);
        cb();
      }
    };
    tick();
    cdTimer = setInterval(tick, 1000);
  }

  const report = () => {
    const now = Date.now();
    if (now - lastReport < 2500) return;
    lastReport = now;
    if (video.readyState >= 2 && video.duration && isFinite(video.duration)) {
      onProgress?.(video.currentTime, video.duration);
    }
  };

  const onTime = () => report();
  const onEnd = () => {
    if (onEnded) onEnded();
  };
  const onSeek = () => report();
  const onPlayState = () => emit();
  const onRateChange = () => emit();
  const onVolumeChange = () => {
    volume = video.muted ? 0 : video.volume;
    emit();
  };

  video.addEventListener('timeupdate', onTime);
  video.addEventListener('seeked', onSeek);
  video.addEventListener('ended', onEnd);
  video.addEventListener('play', onPlayState);
  video.addEventListener('pause', onPlayState);
  video.addEventListener('ratechange', onRateChange);
  video.addEventListener('volumechange', onVolumeChange);
  video.addEventListener('enterpictureinpicture', onPlayState);
  video.addEventListener('leavepictureinpicture', onPlayState);

  applyPlayback();

  return {
    load,
    pauseAll,
    toggleFullscreen,
    nudge,
    countdown,
    setLevel,
    setRate,
    holdRate,
    setVolume,
    toggleMute,
    setFit,
    togglePip,
    snapshot,
    /** 注册状态变化回调（档位 / 倍速 / 音量 / 比例 / 播放状态） */
    onState(fn) {
      stateCb = fn;
      if (fn) fn(snapshot());
    },
    destroy() {
      clearInterval(cdTimer);
      pauseAll();
      stateCb = null;
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onSeek);
      video.removeEventListener('ended', onEnd);
      video.removeEventListener('play', onPlayState);
      video.removeEventListener('pause', onPlayState);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('enterpictureinpicture', onPlayState);
      video.removeEventListener('leavepictureinpicture', onPlayState);
    },
  };
}
