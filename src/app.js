import './index.css'

// All content paths are resolved against this page, so /AR/ and /NAIDOC/test/ work alike.
const $ = id => document.getElementById(id)
const THREE = window.AFRAME && window.AFRAME.THREE
const base = new URL('.', window.location.href)
const localUrl = path => {
  const url = new URL(path, base)
  if (url.origin !== location.origin) throw new Error('Story files must be hosted with this website.')
  return url.href
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const radians = v => v * Math.PI / 180
const logLines = []
function log(message) {
  logLines.push(new Date().toLocaleTimeString() + ' ' + message)
  if (logLines.length > 35) logLines.shift()
  $('diagnostics').textContent = 'NAIDOC Stories v1.1\n' + navigator.userAgent + '\n\n' + logLines.join('\n')
}
function status(title, detail, warning = false) {
  $('status-title').textContent = title
  $('status-detail').textContent = detail
  $('status').classList.toggle('warning', warning)
  document.body.classList.toggle('viewing-story', ['story', 'preview'].includes(phase))
}
async function fetchFile(url, kind = 'json', timeout = 45000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {signal: controller.signal})
    if (!response.ok) throw new Error(`Could not load ${new URL(url).pathname} (${response.status}).`)
    return await (kind === 'json' ? response.json() : response.arrayBuffer())
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Loading timed out: ${new URL(url).pathname}. Check your connection.`)
    throw error
  } finally { clearTimeout(timer) }
}
let manifest, stories = [], targets = [], scene, anchor, pivot, modelEl, current, candidate
let phase = 'welcome', mode = 'ar', trackingNormal = false, needsReanchor = false
let busy = false, operation = 0, worldUnitsPerMetre = 1, placementYaw = 0, modelExtent = 1
let previewYaw = 0, previewPitch = .55, previewDistance = 2.2, previewCentre = .4, sceneWatchdog, loadedStoryId = null
let audioController = null, narrationRequest = 0, audioContext, gain, audioBuffer, source, audioOffset = 0, audioStarted = 0, muted = false
let limitedTimer, captureTimer
const storageKey = 'naidoc-story-settings-v1'
let overrides = {}
try { overrides = JSON.parse(localStorage.getItem(storageKey) || '{}') } catch (_) {}
const numericSettings = {
  sizeMeters: ['size', .1, 8, 1], liftMeters: ['lift', 0, 5, 1],
  yawDegrees: ['yaw', -360, 360, 1], pitchDegrees: ['pitch', -180, 180, 1],
  rollDegrees: ['roll', -180, 180, 1], targetWidthMeters: ['target-width', .01, 2, 100],
}
function settings(story) {
  const result = {...story}
  for (const [key, [,lo,hi]] of Object.entries(numericSettings)) {
    const value = Number(overrides[story.id]?.[key] ?? story[key])
    result[key] = clamp(Number.isFinite(value) ? value : lo, lo, hi)
  }
  return result
}
function showBusy(message) { busy = true; $('busy-text').textContent = message; $('busy').hidden = false }
function hideBusy() { busy = false; $('busy').hidden = true }
function showError(error) {
  log('Error: ' + (error.message || error))
  clearTimeout(sceneWatchdog)
  hideBusy(); pauseAudio()
  $('error-detail').textContent = error.message || String(error)
  if (!$('error-dialog').open) $('error-dialog').showModal()
}
function engineReady() {
  return new Promise((resolve, reject) => {
    if (window.XR8 && XR8.XrController) return resolve()
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      window.removeEventListener('xrloaded', done)
      reject(new Error('The AR engine did not load. Check the connection or use View in 3D.'))
    }, 30000)
    window.addEventListener('xrloaded', done, {once: true})
  })
}
function unlockAudio() {
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioCtor) return
    if (!audioContext) {
      audioContext = new AudioCtor()
      gain = audioContext.createGain(); gain.connect(audioContext.destination)
      audioContext.addEventListener('statechange', updateAudioUI)
    }
    // Invoked directly by a tap, before awaiting camera or network operations.
    audioContext.resume().catch(() => {})
  } catch (error) { log('Audio unavailable: ' + error.message) }
}
function elapsed() {
  return Math.min(audioBuffer?.duration || 0, source ? audioOffset + audioContext.currentTime - audioStarted : audioOffset)
}
function pauseAudio() {
  if (source) {
    audioOffset = elapsed()
    source.onended = null
    try { source.stop() } catch (_) {}
    source.disconnect(); source = null
  }
  updateAudioUI()
}
function clearAudio() {
  narrationRequest++
  audioController?.abort(); audioController = null
  pauseAudio(); audioBuffer = null; audioOffset = 0
  updateAudioUI()
}
async function playAudio() {
  unlockAudio()
  if (!audioContext) { $('audio-message').textContent = 'Audio is unavailable on this browser.'; return }
  if (!audioBuffer) {
    if (current && !audioController) loadNarration(current, true)
    return
  }
  try {
    await audioContext.resume()
    if (source || !audioBuffer || !['story', 'preview'].includes(phase) || document.hidden) return
    if (audioContext.state !== 'running') throw new Error('Tap play to enable sound.')
    if (audioOffset >= audioBuffer.duration - .05) audioOffset = 0
    source = audioContext.createBufferSource(); source.buffer = audioBuffer
    source.connect(gain); gain.gain.value = muted ? 0 : 1
    audioStarted = audioContext.currentTime
    source.onended = () => { source?.disconnect(); source = null; audioOffset = audioBuffer?.duration || 0; updateAudioUI() }
    source.start(0, audioOffset)
    $('audio-message').textContent = ''
  } catch (_) { $('audio-message').textContent = 'Tap play to start the story.' }
  updateAudioUI()
}
async function loadNarration(story, autoplay) {
  clearAudio()
  const request = narrationRequest
  if (!story.audio) { $('audio-message').textContent = 'This artwork has no recording yet.'; return }
  if (!audioContext) { $('audio-message').textContent = 'Tap play to load the story.'; return }
  $('audio-message').textContent = 'Loading the story…'
  const controller = new AbortController(); audioController = controller
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    const response = await fetch(localUrl(story.audio), {signal: controller.signal})
    if (!response.ok) throw new Error('Recording could not be loaded.')
    const bytes = await response.arrayBuffer()
    const decoded = await audioContext.decodeAudioData(bytes)
    if (request !== narrationRequest) return
    audioBuffer = decoded; audioOffset = 0
    $('audio-message').textContent = ''
    if (autoplay && ['story','preview'].includes(phase) && !document.hidden) await playAudio()
  } catch (error) {
    if (request === narrationRequest) {
      $('audio-message').textContent = 'Recording did not load. Tap play to try again.'
      log('Recording: ' + error.message)
    }
  } finally {
    clearTimeout(timer)
    if (request === narrationRequest) audioController = null
    updateAudioUI()
  }
}
function clock(seconds) { const n = Math.floor(seconds || 0); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2,'0') }
function updateAudioUI() {
  const playing = !!source && audioContext?.state === 'running'
  $('play').textContent = playing ? 'Ⅱ' : '▶'
  $('play').setAttribute('aria-label', playing ? 'Pause narration' : 'Play narration')
  $('elapsed').textContent = clock(elapsed()); $('duration').textContent = clock(audioBuffer?.duration)
  if (document.activeElement !== $('seek')) $('seek').value = audioBuffer ? elapsed() / audioBuffer.duration * 1000 : 0
  $('seek').disabled = !audioBuffer
}
setInterval(updateAudioUI, 250)

function disposeModel() {
  loadedStoryId = null
  if (!modelEl) return
  const textures = new Set(), materials = new Set(), geometries = new Set()
  modelEl.object3D.traverse(object => {
    if (object.geometry) geometries.add(object.geometry)
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      if (!material) continue
      materials.add(material)
      Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value) })
    }
  })
  textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose()); geometries.forEach(g => g.dispose())
  modelEl.remove(); modelEl = null
}
function applyModelSettings() {
  if (!current || !modelEl || !pivot) return
  const cfg = settings(current)
  pivot.object3D.rotation.set(radians(cfg.pitchDegrees), radians(cfg.yawDegrees) + (mode === 'preview' ? previewYaw : 0), radians(cfg.rollDegrees), 'YXZ')
  const scale = mode === 'preview' ? 1.25 / modelExtent : cfg.sizeMeters * worldUnitsPerMetre / modelExtent
  pivot.object3D.scale.setScalar(scale)
  pivot.object3D.position.y = mode === 'preview' ? 0 : cfg.liftMeters * worldUnitsPerMetre
}
function loadModel(story) {
  disposeModel()
  return new Promise((resolve, reject) => {
    const element = document.createElement('a-entity')
    modelEl = element
    let finished = false
    const timer = setTimeout(() => done(new Error('The artwork took too long to load. Check the connection and try again.')), 60000)
    function done(error) {
      if (finished) return
      finished = true; clearTimeout(timer)
      error ? reject(error) : resolve()
    }
    element.addEventListener('model-error', () => done(new Error('The 3D model could not be loaded: ' + story.model)), {once: true})
    element.addEventListener('model-loaded', () => {
      if (modelEl !== element) { done(new Error('Artwork loading was cancelled.')); return }
      const object = element.getObject3D('mesh')
      // Calculate bounds before applying display scaling. Preserve original brush materials.
      const parent = object.parent
      parent.remove(object)
      object.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(object)
      parent.add(object)
      const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3())
      modelExtent = Math.max(size.x, size.y, size.z)
      if (!Number.isFinite(modelExtent) || modelExtent <= 0) { done(new Error('This model has no visible geometry.')); return }
      object.position.x -= centre.x; object.position.z -= centre.z; object.position.y -= box.min.y
      loadedStoryId = story.id
      applyModelSettings()
      if (mode === 'preview') { previewCentre = size.y / modelExtent * 1.25 / 2; updatePreviewCamera() }
      log('Loaded ' + story.model + '; longest side ' + modelExtent.toFixed(3))
      done()
    }, {once: true})
    pivot.appendChild(element)
    element.setAttribute('gltf-model', localUrl(story.model))
  })
}
function buildScene(isPreview) {
  scene = document.createElement('a-scene')
  scene.id = 'story-scene'
  scene.setAttribute('vr-mode-ui', 'enabled: false')
  scene.setAttribute('device-orientation-permission-ui', 'enabled: false')
  scene.setAttribute('renderer', 'colorManagement: true; alpha: true; antialias: true; maxCanvasWidth: 1600; maxCanvasHeight: 1600')
  if (isPreview) scene.setAttribute('background', 'color: #eadcc5')
  scene.innerHTML = '<a-camera id="story-camera" position="0 1.3 2.9" look-controls="enabled: false" wasd-controls="enabled: false"></a-camera><a-entity light="type: ambient; intensity: 1.1"></a-entity><a-entity light="type: directional; intensity: 1.2" position="2 4 3"></a-entity><a-entity light="type: directional; intensity: 0.5" position="-3 2 -2"></a-entity><a-entity id="story-anchor" visible="false"><a-entity id="model-pivot"></a-entity></a-entity>'
  anchor = scene.querySelector('#story-anchor'); pivot = scene.querySelector('#model-pivot')
  if (!isPreview) {
    scene.addEventListener('xrimagefound', onTarget)
    scene.addEventListener('xrimageupdated', onTarget)
    scene.addEventListener('xrimagelost', ({detail}) => { if (candidate?.name === detail.name) resetCandidate() })
    scene.addEventListener('xrimagescanning', () => {
      clearTimeout(sceneWatchdog); log('Image scanner ready')
      if (phase === 'starting') phase = 'scanning'
      status('Find a painting', 'Hold your device close enough to see the painted details.')
    })
    scene.addEventListener('xrtrackingstatus', onTracking)
    scene.addEventListener('realityerror', event => showError(new Error(event.detail?.error?.message || event.detail?.message || 'The camera or tracking could not start.')))
    scene.setAttribute('xrconfig', 'cameraDirection: back; allowedDevices: mobile; disableDefaultEnvironment: true')
    scene.setAttribute('xrweb', 'scale: responsive; disableWorldTracking: false')
  }
  $('scene-host').appendChild(scene)
  return new Promise(resolve => {
    const ready = () => {
      if (isPreview) { attachOrbit(); updatePreviewCamera() }
      resolve()
    }
    scene.hasLoaded ? ready() : scene.addEventListener('loaded', ready, {once:true})
  })
}
async function startExperience(preview = false) {
  if (!stories.length || phase !== 'welcome') return
  unlockAudio()
  // Request motion permission in the initial user gesture on iOS.
  if (!preview) {
    for (const event of [window.DeviceMotionEvent, window.DeviceOrientationEvent]) {
      if (typeof event?.requestPermission === 'function') event.requestPermission().catch(error => log('Motion permission: ' + error.message))
    }
  }
  mode = preview ? 'preview' : 'ar'; phase = 'starting'
  $('welcome').hidden = true; $('experience').hidden = false
  document.body.classList.add('in-experience')
  $('scan-guide').hidden = preview; $('preview-picker').hidden = !preview
  $('mode-label').textContent = preview ? '3D ARTWORK VIEW' : 'FIND A PAINTING'
  if (preview) {
    status('Explore the artwork', 'This is a 3D view. Use the camera experience to place it in the circle.')
    await buildScene(true)
    return showStory(stories[0], null)
  }
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS and a supported browser.')
    status('Opening the camera', 'Allow camera and motion access when asked.')
    await engineReady()
    XR8.XrController.configure({imageTargetData: targets, disableWorldTracking: false, scale: 'responsive'})
    sceneWatchdog = setTimeout(() => showError(new Error('The camera or image targets did not finish loading. Check camera permissions and your connection.')), 60000)
    await buildScene(false)
    captureTimer = setInterval(() => {
      if (candidate && performance.now() - candidate.last > 400) resetCandidate()
    }, 250)
  } catch (error) { showError(error) }
}
function resetCandidate() { candidate = null; $('scan-progress').value = 0; $('scan-instruction').textContent = needsReanchor ? 'Scan the same painting to place it again.' : 'Fill the frame with the painting.' }
function onTarget({detail}) {
  if (!['scanning','reacquiring'].includes(phase) || busy || !trackingNormal || document.hidden) return
  const story = stories.find(s => s.targetName === detail.name)
  if (!story || (needsReanchor && story.id !== current?.id)) return
  if (!detail.position || ![detail.position.x,detail.position.y,detail.position.z,detail.scale,detail.scaledWidth].every(Number.isFinite)) return
  const cfg = settings(story)
  const units = detail.scaledWidth * detail.scale / (cfg.targetWidthMeters * (story.targetImageWidthFactor || 1))
  if (units <= 0) return
  const now = performance.now(), point = new THREE.Vector3().copy(detail.position)
  if (!candidate || candidate.name !== detail.name || now - candidate.last > 400 || point.distanceTo(candidate.position) > units * .045) {
    candidate = {name:detail.name, since:now, last:now, count:1, position:point, units}
  } else {
    candidate.position.lerp(point, .25); candidate.units = candidate.units * .75 + units * .25
    candidate.last = now; candidate.count++
  }
  $('scan-instruction').textContent = 'Painting found. Hold still for a moment…'
  $('scan-progress').value = Math.min(1,(now - candidate.since)/850)
  if (now - candidate.since >= 850 && candidate.count >= 8) {
    const pose = {position:candidate.position.clone(),units:candidate.units}
    phase = 'loading'
    showStory(story, pose)
  }
}
function onTracking({detail}) {
  trackingNormal = detail.status === 'NORMAL'
  log('Tracking ' + detail.status)
  clearTimeout(limitedTimer)
  if (!trackingNormal) {
    resetCandidate()
    if (current && phase === 'story') {
      anchor.object3D.visible = false; pauseAudio()
      status('Finding the surroundings', 'Move slowly and point towards the painting and nearby ground.', true)
      limitedTimer = setTimeout(() => { if (!trackingNormal && phase === 'story') beginRescan() }, 1500)
    }
  } else if (phase === 'story' && !needsReanchor) {
    anchor.object3D.visible = true
    status('Your artwork is in place', 'Take your seat and listen. Tap play to continue the recording.')
  } else if (phase === 'scanning') {
    status('Find a painting', 'Hold your device close enough to see the painted details.')
  }
}
async function showStory(story, pose) {
  const op = ++operation
  const reusing = needsReanchor && current?.id === story.id && loadedStoryId === story.id
  current = story; $('setup-story').value = story.id; $('story-select').value = story.id
  $('scan-guide').hidden = true; resetCandidate()
  $('story-title').textContent = story.title; $('story-number').textContent = 'STORY ' + String(story.id).padStart(2,'0')
  $('story-panel').hidden = false; $('rescan').hidden = mode === 'preview'
  $('another').parentElement.hidden = mode === 'preview'
  if (pose) {
    worldUnitsPerMetre = pose.units
    anchor.object3D.position.copy(pose.position)
    const cameraPosition = new THREE.Vector3()
    $('story-camera').object3D.getWorldPosition(cameraPosition)
    placementYaw = Math.atan2(cameraPosition.x - pose.position.x, cameraPosition.z - pose.position.z)
    anchor.object3D.rotation.set(0, placementYaw, 0)
    log('Placed ' + story.targetName + '; units/metre ' + pose.units.toFixed(3))
  } else {
    worldUnitsPerMetre = 1; anchor.object3D.position.set(0,0,0); anchor.object3D.rotation.set(0,0,0)
    previewYaw = 0; previewPitch = .55; previewDistance = 2.2; updatePreviewCamera()
  }
  try {
    if (!reusing) {
      clearAudio(); anchor.object3D.visible = false
      pivot.object3D.scale.setScalar(1); pivot.object3D.rotation.set(0,0,0); pivot.object3D.position.set(0,0,0)
      showBusy('Loading ' + story.title + '…')
      await loadModel(story)
    } else applyModelSettings()
    if (op !== operation) return
    hideBusy()
    needsReanchor = false
    phase = mode === 'preview' ? 'preview' : 'story'
    document.body.classList.add('viewing-story')
    anchor.object3D.visible = mode === 'preview' || trackingNormal
    $('mode-label').textContent = mode === 'preview' ? '3D ARTWORK VIEW' : 'STORY IN PLACE'
    if (mode === 'ar') status('Your artwork is in place', 'You can move back to your seat. Keep the device looking into the circle.')
    if (!reusing) loadNarration(story, mode === 'ar')
    else { $('audio-message').textContent = 'Artwork repositioned. Tap play to continue.'; updateAudioUI() }
    if (mode === 'ar' && !trackingNormal) beginRescan()
  } catch (error) { if (op === operation) showError(error) }
}
function beginRescan() {
  if (!current || mode !== 'ar') return
  ++operation; hideBusy(); pauseAudio(); needsReanchor = true; phase = 'reacquiring'
  anchor.object3D.visible = false; resetCandidate()
  $('scan-guide').hidden = false; $('story-panel').hidden = true
  $('mode-label').textContent = 'SCAN TO REPOSITION'
  status('Find the same painting again', 'The story is paused. Scan the painting to place the artwork again.', true)
}
function anotherStory() {
  if (mode === 'preview') { $('story-select').focus(); return }
  ++operation; hideBusy(); clearAudio(); disposeModel(); current = null; needsReanchor = false
  phase = 'scanning'; anchor.object3D.visible = false; resetCandidate()
  $('story-panel').hidden = true; $('scan-guide').hidden = false
  $('mode-label').textContent = 'FIND A PAINTING'
  status('Choose another painting', 'Move close enough to see the painted details.')
}
function updatePreviewCamera() {
  const camera = $('story-camera')?.object3D
  if (!camera || mode !== 'preview') return
  camera.position.set(0, previewCentre + Math.sin(previewPitch) * previewDistance, Math.cos(previewPitch) * previewDistance)
  // The entity is a Group: Group.lookAt faces +Z, whereas its child camera faces -Z.
  camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(camera.position, new THREE.Vector3(0,previewCentre,0), new THREE.Vector3(0,1,0)))
}
function attachOrbit() {
  const canvas = scene.canvas, pointers = new Map()
  if (!canvas) return
  canvas.style.touchAction = 'none'
  canvas.addEventListener('pointerdown', event => { pointers.set(event.pointerId,{x:event.clientX,y:event.clientY}); canvas.setPointerCapture(event.pointerId) })
  const distance = () => { const p = [...pointers.values()]; return p.length === 2 ? Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y) : 0 }
  canvas.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId)
    if (!previous) return
    const before = distance()
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY})
    if (pointers.size === 1) {
      previewYaw += (event.clientX-previous.x)*.009
      previewPitch = clamp(previewPitch+(event.clientY-previous.y)*.006,-.4,1.2)
    } else if (before > 0) previewDistance = clamp(previewDistance*before/Math.max(distance(),1),1.2,6)
    applyModelSettings(); updatePreviewCamera()
  })
  for (const name of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(name,event => pointers.delete(event.pointerId))
  canvas.addEventListener('wheel',event => { event.preventDefault(); previewDistance=clamp(previewDistance+event.deltaY*.003,1.2,6); updatePreviewCamera() },{passive:false})
}
function openSetup() {
  if (!stories.length) return
  $('setup-story').value = current?.id || stories[0].id
  populateSetup(); $('setup-dialog').showModal()
}
function populateSetup() {
  const story = stories.find(s => s.id === $('setup-story').value)
  if (!story) return
  const cfg = settings(story)
  for (const [key,[id,,,factor]] of Object.entries(numericSettings)) $(id).value = Number((cfg[key]*factor).toFixed(3))
  $('settings-message').textContent = ''
}
function saveSettings() {
  const story = stories.find(s => s.id === $('setup-story').value)
  if (!story) return
  const values = {}
  for (const [key,[id,lo,hi,factor]] of Object.entries(numericSettings)) {
    if (!$(id).checkValidity() || $(id).value === '') return
    values[key] = clamp(Number($(id).value)/factor,lo,hi)
  }
  overrides[story.id] = values
  try { localStorage.setItem(storageKey,JSON.stringify(overrides)); $('settings-message').textContent = 'Saved on this device.' }
  catch (_) { $('settings-message').textContent = 'Applied for this visit. Export to keep these settings.' }
  if (current?.id === story.id) applyModelSettings()
}
function exportSettings() {
  const updated = {...manifest,stories:manifest.stories.map(s => ({...s,...(overrides[String(s.id)] || {})}))}
  const blob = new Blob([JSON.stringify(updated,null,2)+'\n'],{type:'application/json'})
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = 'stories.json'; document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url),2000)
  $('settings-message').textContent = 'Replace src/assets/stories.json in GitHub with the downloaded file to share these settings.'
}
async function init() {
  log('Opening ' + location.pathname)
  if (!THREE) throw new Error('A-Frame did not load. Check the local 8frame script.')
  manifest = await fetchFile(localUrl('assets/stories.json'))
  if (!Array.isArray(manifest.stories)) throw new Error('stories.json must contain a stories list.')
  stories = manifest.stories.filter(s => s.enabled !== false).map(s => ({...s,id:String(s.id)}))
  if (!stories.length) throw new Error('No stories are enabled yet.')
  if (stories.length > 32) throw new Error('Use up to 32 enabled stories in this version.')
  if (new Set(stories.map(s => s.id)).size !== stories.length || new Set(stories.map(s => s.targetName)).size !== stories.length) throw new Error('Each story needs its own ID and targetName.')
  for (const story of stories) {
    for (const key of ['title','model','target','targetName']) if (!story[key]) throw new Error('Story '+story.id+' is missing '+key+'.')
    for (const key of ['model','audio','target','image']) if (story[key]) localUrl(story[key])
    for (const id of ['story-select','setup-story']) {
      const option = document.createElement('option'); option.value=story.id; option.textContent=story.title; $(id).appendChild(option)
    }
  }
  if (stories[0].image) { $('hero').src = localUrl(stories[0].image); $('hero').alt = stories[0].imageAlt || stories[0].title }
  $('story-count').textContent = String(stories.length).padStart(2,'0') + (stories.length === 1 ? ' STORY' : ' STORIES')
  $('preview').disabled = false
  // One missing target must not prevent the normal 3D fallback from opening.
  try {
    targets = await Promise.all(stories.map(async story => {
      const target = await fetchFile(localUrl(story.target))
      if (target.name !== story.targetName) throw new Error(story.target+' has a different target name.')
      if (!target.properties || !target.imagePath) throw new Error(story.target+' is not a compiled 8th Wall target.')
      target.imagePath = localUrl(target.imagePath)
      return target
    }))
    $('start').disabled = false; $('start').textContent = 'Begin the experience →'
    log(stories.length + ' story target(s) ready')
  } catch (error) { $('start').textContent = 'Camera experience unavailable'; $('welcome-error').textContent=error.message; log(error.message) }
}
// Fullscreen keeps the camera, artwork and accessible controls together.
let focusView = false, fullscreenNoteTimer
function setFocusView(enabled) {
  focusView = enabled
  document.body.classList.toggle('focus-view', enabled)
  $('fullscreen').textContent = enabled ? 'Exit full screen' : 'Full screen'
  $('fullscreen').setAttribute('aria-pressed', String(enabled))
  $('fullscreen-note').hidden = true
  window.dispatchEvent(new Event('resize'))
}
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement
$('fullscreen').addEventListener('click', async () => {
  if (focusView) {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen
      if (fullscreenElement() && exit) await exit.call(document)
    } catch (error) { log('Exit fullscreen: ' + error.message) }
    setFocusView(false)
    return
  }
  setFocusView(true)
  try {
    const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen
    if (!request) throw new Error('Fullscreen unavailable')
    await request.call(document.documentElement)
  } catch (_) {
    $('fullscreen-note').textContent = 'Expanded view — this browser keeps its address bar visible.'
    $('fullscreen-note').hidden = false
    clearTimeout(fullscreenNoteTimer)
    fullscreenNoteTimer = setTimeout(() => { $('fullscreen-note').hidden = true }, 5000)
  }
})
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, () => setFocusView(!!fullscreenElement()))
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && focusView && !fullscreenElement()) setFocusView(false)
})

$('start').addEventListener('click', () => startExperience(false))
$('preview').addEventListener('click', () => startExperience(true))
$('home').addEventListener('click', () => { const url = new URL(location.href); url.searchParams.delete('view'); location.href = url.href })
$('reload').addEventListener('click', () => location.reload())
$('error-preview').addEventListener('click', () => { const url=new URL(location.href);url.searchParams.set('view','3d');location.href=url.href })
$('open-setup').addEventListener('click',openSetup); $('welcome-setup').addEventListener('click',openSetup)
$('setup-story').addEventListener('change',populateSetup)
for (const [id] of Object.values(numericSettings)) $(id).addEventListener('input',saveSettings)
$('export-settings').addEventListener('click',exportSettings)
$('reset-settings').addEventListener('click',() => {
  delete overrides[$('setup-story').value]
  try { localStorage.setItem(storageKey,JSON.stringify(overrides)) } catch (_) {}
  populateSetup(); applyModelSettings()
})
$('play').addEventListener('click',() => source ? pauseAudio() : playAudio())
$('restart').addEventListener('click',() => { pauseAudio(); audioOffset=0; playAudio() })
$('seek').addEventListener('change',() => { const playing=!!source; pauseAudio(); audioOffset=Number($('seek').value)/1000*(audioBuffer?.duration||0); if (playing) playAudio(); updateAudioUI() })
$('mute').addEventListener('click',() => { muted=!muted; if(gain)gain.gain.value=muted?0:1; $('mute').textContent=muted?'Muted':'Sound on'; $('mute').setAttribute('aria-pressed',String(muted)); $('mute').setAttribute('aria-label',muted?'Unmute narration':'Mute narration') })
$('rescan').addEventListener('click',beginRescan); $('another').addEventListener('click',anotherStory)
$('story-select').addEventListener('change',() => { const story=stories.find(s=>s.id===$('story-select').value);if(story)showStory(story,null) })
document.addEventListener('visibilitychange',() => {
  if (document.hidden && phase !== 'welcome') {
    pauseAudio();resetCandidate()
    if (mode==='ar') {
      ++operation;hideBusy()
      if(anchor)anchor.object3D.visible=false
      try { window.XR8?.pause() } catch (_) {}
      $('resume').hidden=false
      status('Paused while you were away','Tap Continue, then scan the painting again.')
    }
  }
})
$('resume').addEventListener('click',() => {
  unlockAudio();$('resume').hidden=true
  try { window.XR8?.resume() } catch(error) { showError(error);return }
  current ? beginRescan() : anotherStory()
})
window.addEventListener('pagehide',() => { clearAudio();try{window.XR8?.stop()}catch(_){};clearInterval(captureTimer);clearTimeout(limitedTimer);clearTimeout(sceneWatchdog) })
window.addEventListener('unhandledrejection',event => log('Promise: '+(event.reason?.message || event.reason)))
init().then(() => {
  if(new URL(location.href).searchParams.get('view')==='3d') $('preview').click()
}).catch(error => { $('welcome-error').textContent=error.message; $('start').textContent='Unable to load stories';log(error.message) })
