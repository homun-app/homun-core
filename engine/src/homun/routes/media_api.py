"""REST API routes for vision analysis, image/video generation, STT, TTS, and voice mode (H41)."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from homun.application.media_image_gen import ImageGenerator
from homun.application.media_stt import SpeechToTextTranscriber
from homun.application.media_tts import TextToSpeechSynthesizer
from homun.application.media_video_gen import VideoGenerator
from homun.application.media_vision import VisionAnalyzer
from homun.application.media_voice_mode import VoiceSession, WakeWordDetector

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/media", tags=["media"])

_vision_analyzer = VisionAnalyzer()
_image_generator = ImageGenerator()
_video_generator = VideoGenerator()
_stt_transcriber = SpeechToTextTranscriber()
_tts_synthesizer = TextToSpeechSynthesizer()
_voice_session = VoiceSession()


class VisionAnalyzeRequest(BaseModel):
    image_source: str
    prompt: Optional[str] = "Describe what you see in this image."


class ImageGenerateRequest(BaseModel):
    prompt: str
    aspect_ratio: Optional[str] = "1:1"
    model: Optional[str] = None
    seed: Optional[int] = None


class ImageEditRequest(BaseModel):
    prompt: str
    image_urls: List[str]
    aspect_ratio: Optional[str] = "1:1"
    model: Optional[str] = None


class VideoGenerateRequest(BaseModel):
    prompt: str
    duration_seconds: Optional[int] = 5
    aspect_ratio: Optional[str] = "16:9"
    resolution: Optional[str] = "720p"


class SttTranscribeRequest(BaseModel):
    audio_path: str
    language: Optional[str] = None
    provider: Optional[str] = None


class TtsSynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    audio_format: Optional[str] = "mp3"
    provider: Optional[str] = None


class WakeCheckRequest(BaseModel):
    phrase: str


@router.post("/vision/analyze", response_model=Dict[str, Any])
def analyze_vision(req: VisionAnalyzeRequest) -> Dict[str, Any]:
    """Analyze image content with vision models."""
    res = _vision_analyzer.analyze_image(req.image_source, prompt=req.prompt or "")
    if res.error:
        raise HTTPException(status_code=400, detail=res.error)
    return {
        "description": res.description,
        "tokens_used": res.tokens_used,
        "mime_type": res.mime_type,
        "metadata": res.metadata,
    }


@router.post("/image/generate", response_model=Dict[str, Any])
def generate_image(req: ImageGenerateRequest) -> Dict[str, Any]:
    """Generate image from prompt."""
    res = _image_generator.generate(
        req.prompt,
        aspect_ratio=req.aspect_ratio or "1:1",
        model=req.model,
        seed=req.seed,
    )
    if res.error:
        raise HTTPException(status_code=400, detail=res.error)
    return {
        "image_url": res.image_url,
        "prompt": res.prompt,
        "model": res.model,
        "aspect_ratio": res.aspect_ratio,
        "seed": res.seed,
        "metadata": res.metadata,
    }


@router.post("/image/edit", response_model=Dict[str, Any])
def edit_image(req: ImageEditRequest) -> Dict[str, Any]:
    """Edit existing images based on instructions."""
    res = _image_generator.edit(
        req.prompt,
        req.image_urls,
        aspect_ratio=req.aspect_ratio or "1:1",
        model=req.model,
    )
    if res.error:
        raise HTTPException(status_code=400, detail=res.error)
    return {
        "image_url": res.image_url,
        "prompt": res.prompt,
        "model": res.model,
        "aspect_ratio": res.aspect_ratio,
        "metadata": res.metadata,
    }


@router.post("/video/generate", response_model=Dict[str, Any])
def generate_video(req: VideoGenerateRequest) -> Dict[str, Any]:
    """Generate video from text prompt."""
    res = _video_generator.generate(
        req.prompt,
        duration_seconds=req.duration_seconds or 5,
        aspect_ratio=req.aspect_ratio or "16:9",
        resolution=req.resolution or "720p",
    )
    if res.error:
        raise HTTPException(status_code=400, detail=res.error)
    return {
        "video_url": res.video_url,
        "prompt": res.prompt,
        "duration_seconds": res.duration_seconds,
        "aspect_ratio": res.aspect_ratio,
        "resolution": res.resolution,
        "status": res.status,
    }


@router.post("/stt/transcribe", response_model=Dict[str, Any])
def transcribe_stt(req: SttTranscribeRequest) -> Dict[str, Any]:
    """Transcribe audio to text."""
    res = _stt_transcriber.transcribe(
        req.audio_path,
        language=req.language,
        provider=req.provider,
    )
    if res.error:
        raise HTTPException(status_code=400, detail=res.error)
    return {
        "text": res.text,
        "duration_seconds": res.duration_seconds,
        "language": res.language,
        "provider": res.provider,
    }


@router.post("/tts/synthesize", response_model=Dict[str, Any])
def synthesize_tts(req: TtsSynthesizeRequest) -> Dict[str, Any]:
    """Synthesize text to speech audio."""
    res = _tts_synthesizer.synthesize(
        req.text,
        voice=req.voice,
        audio_format=req.audio_format or "mp3",
        provider=req.provider,
    )
    if res.error:
        raise HTTPException(status_code=400, detail=res.error)
    return {
        "audio_url": res.audio_url,
        "audio_format": res.audio_format,
        "duration_seconds": res.duration_seconds,
        "provider": res.provider,
        "text": res.text,
    }


@router.post("/voice/wake-check", response_model=Dict[str, Any])
def check_wake_word(req: WakeCheckRequest) -> Dict[str, Any]:
    """Check phrase for wake word detection."""
    event = _voice_session.trigger_wake(req.phrase)
    return {
        "detected": event is not None,
        "wake_word": event.wake_word if event else None,
        "state": _voice_session.state,
    }
