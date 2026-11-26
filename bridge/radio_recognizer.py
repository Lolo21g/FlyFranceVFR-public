"""
FlyFranceVFR — Reconnaissance vocale radio hors-ligne (Vosk)

Capture le micro directement côté bridge (indépendant du navigateur et de
WebView2) et transcrit en français via un modèle Vosk embarqué. Piloté par
les messages WebSocket 'radioListenStart' / 'radioListenStop' envoyés par
radio_logic.js (le PTT joystick/clavier reste détecté côté page, seul le
moteur de reconnaissance change).

Dépendances : pip install vosk sounddevice
Modèle attendu à côté de l'exécutable, ex. vosk-model-small-fr-0.22
(https://alphacephei.com/vosk/models — modèle "small" FR ~40 Mo).
"""

import asyncio
import json
import logging
import queue
import threading

log = logging.getLogger("msfs_bridge.radio_recognizer")

try:
    import sounddevice as sd
    HAS_SOUNDDEVICE = True
except ImportError:
    HAS_SOUNDDEVICE = False

try:
    import vosk
    vosk.SetLogLevel(-1)  # silence les logs Kaldi internes sur stdout
    HAS_VOSK = True
except ImportError:
    HAS_VOSK = False

SAMPLE_RATE = 16000
BLOCK_SIZE = 8000  # ~0.5 s de flux à 16 kHz


class RadioRecognizer:
    """
    Une session = un appui PTT. start() ouvre le micro et lance le décodage
    en arrière-plan ; stop() ferme le micro et renvoie le texte complet
    accumulé sur toute la durée de l'appui (plusieurs segments Vosk peuvent
    se succéder si le pilote marque une pause au milieu de sa phrase — on
    les concatène pour reproduire le comportement de l'ancien moteur
    navigateur en mode continu).
    """

    def __init__(self, model_path, loop, on_result):
        """
        model_path : chemin du dossier modèle Vosk (str/Path).
        loop       : boucle asyncio du bridge (celle qui fait tourner le
                     serveur WebSocket).
        on_result  : coroutine async def on_result(text, final, error=None)
                     appelée (via run_coroutine_threadsafe) à chaque mise à
                     jour ; error est renseigné si le micro/modèle est
                     indisponible.
        """
        self.loop = loop
        self.on_result = on_result
        self.model = None
        self.model_error = None
        self._rec = None
        self._stream = None
        self._audio_q = queue.Queue()
        self._worker = None
        self._running = False
        self._segments = []
        self._lock = threading.Lock()

        if not HAS_VOSK or not HAS_SOUNDDEVICE:
            self.model_error = ("Modules 'vosk'/'sounddevice' manquants "
                                 "(pip install vosk sounddevice).")
            log.warning(self.model_error)
            return
        try:
            self.model = vosk.Model(str(model_path))
            log.info(f"Modèle Vosk chargé : {model_path}")
        except Exception as e:
            self.model_error = f"Impossible de charger le modèle Vosk ({model_path}) : {e}"
            log.warning(self.model_error)

    def available(self):
        return self.model is not None

    def start(self):
        with self._lock:
            if self._running:
                return
            if not self.available():
                self._emit('', True, error=self.model_error or "Reconnaissance vocale indisponible.")
                return
            self._running = True
            self._segments = []
            self._rec = vosk.KaldiRecognizer(self.model, SAMPLE_RATE)
            self._rec.SetWords(False)
            try:
                self._stream = sd.RawInputStream(
                    samplerate=SAMPLE_RATE, blocksize=BLOCK_SIZE,
                    dtype='int16', channels=1, callback=self._audio_callback)
                self._stream.start()
            except Exception as e:
                self._running = False
                self._rec = None
                log.warning(f"Ouverture micro Vosk échouée : {e}")
                self._emit('', True, error=f"Micro indisponible : {e}")
                return
            self._worker = threading.Thread(target=self._process_loop, daemon=True)
            self._worker.start()
            log.info("🎙️ Reconnaissance radio (Vosk) démarrée")

    def stop(self):
        with self._lock:
            if not self._running:
                return
            self._running = False
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception as e:
                log.warning(f"Fermeture flux micro Vosk : {e}")
            self._stream = None
        if self._worker:
            self._worker.join(timeout=1.0)
            self._worker = None
        if self._rec:
            try:
                result = json.loads(self._rec.FinalResult())
                text = (result.get('text') or '').strip()
                if text:
                    self._segments.append(text)
            except Exception as e:
                log.warning(f"Résultat final Vosk : {e}")
        self._rec = None
        with self._audio_q.mutex:
            self._audio_q.queue.clear()
        final_text = ' '.join(self._segments).strip()
        self._segments = []
        self._emit(final_text, True)
        log.info("🎙️ Reconnaissance radio (Vosk) arrêtée")

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            log.warning(f"Statut flux micro Vosk : {status}")
        self._audio_q.put(bytes(indata))

    def _process_loop(self):
        while self._running:
            try:
                data = self._audio_q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                if self._rec.AcceptWaveform(data):
                    result = json.loads(self._rec.Result())
                    text = (result.get('text') or '').strip()
                    if text:
                        self._segments.append(text)
                    joined = ' '.join(self._segments).strip()
                    if joined:
                        self._emit(joined, False)
                else:
                    partial = json.loads(self._rec.PartialResult())
                    ptext = (partial.get('partial') or '').strip()
                    joined = ' '.join(self._segments + ([ptext] if ptext else [])).strip()
                    if joined:
                        self._emit(joined, False)
            except Exception as e:
                log.warning(f"Traitement audio Vosk : {e}")

    def _emit(self, text, final, error=None):
        try:
            asyncio.run_coroutine_threadsafe(self.on_result(text, final, error), self.loop)
        except Exception as e:
            log.warning(f"Envoi résultat Vosk : {e}")
