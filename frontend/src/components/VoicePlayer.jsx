import React, { useEffect, useRef } from "react";

export default function VoicePlayer({ audioUrl, commentary }) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (audioUrl && audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
  }, [audioUrl]);

  return (
    <div className="voice-player">
      <div className="pundit-header">
        <span className="pundit-icon">🎙️</span>
        <span className="pundit-label">Pundit Call</span>
      </div>
      {commentary && <p className="commentary">{commentary}</p>}
      {audioUrl && (
        <audio ref={audioRef} src={audioUrl} controls className="audio-player" />
      )}
    </div>
  );
}
