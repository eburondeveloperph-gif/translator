/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef, memo, useState } from 'react';
import { LiveConnectConfig, Modality, LiveServerContent } from '@google/genai';

import { useLiveAPIContext } from '../../../contexts/LiveAPIContext';
import {
  useSettings,
  useLogStore,
  useTools,
} from '@/lib/state';

// Component to render the "Videoke" style text
const SubtitleText = memo(({ text, translation }: { text: string, translation?: string }) => {
  return (
    <div className="subtitle-entry">
      <div className="subtitle-source">
        {text}
      </div>
      <div className="subtitle-translation">
        {translation || <span className="typing-indicator">...</span>}
      </div>
    </div>
  );
});

// Digital Clock Component
const DigitalClock = () => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="digital-clock">
      <div className="clock-time">
        {time.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </div>
      <div className="clock-date">
        {time.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
      </div>
    </div>
  );
};

export default function StreamingConsole() {
  const { client, setConfig } = useLiveAPIContext();
  const { systemPrompt, voice } = useSettings();
  const { tools } = useTools();
  const turns = useLogStore(state => state.turns);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const config: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice,
          },
        },
      },
      // Updated to use empty objects as per latest API spec for default models
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: systemPrompt, 
    };

    const enabledTools = tools
      .filter(tool => tool.isEnabled)
      .map(tool => ({
        functionDeclarations: [
          {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        ],
      }));

    if (enabledTools.length > 0) {
      config.tools = enabledTools;
    }

    setConfig(config);
  }, [setConfig, systemPrompt, tools, voice]);

  useEffect(() => {
    // We strictly use DatabaseBridge for UI updates via Supabase
    // But we need to keep event listeners active for connection health
    const handleInputTranscription = (text: string, isFinal: boolean) => {};
    const handleOutputTranscription = (text: string, isFinal: boolean) => {};
    const handleContent = (serverContent: LiveServerContent) => {};
    const handleTurnComplete = () => {};

    client.on('inputTranscription', handleInputTranscription);
    client.on('outputTranscription', handleOutputTranscription);
    client.on('content', handleContent);
    client.on('turncomplete', handleTurnComplete);

    return () => {
      client.off('inputTranscription', handleInputTranscription);
      client.off('outputTranscription', handleOutputTranscription);
      client.off('content', handleContent);
      client.off('turncomplete', handleTurnComplete);
    };
  }, [client]);

  // Scroll to bottom when turns change
  useEffect(() => {
    if (scrollRef.current) {
      const scrollElement = scrollRef.current;
      // Use smooth scroll behavior
      scrollElement.scrollTo({
        top: scrollElement.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [turns]);

  // Filter: Only show "system" turns which contain our Script
  const scriptTurns = turns.filter(t => t.role === 'system');

  return (
    <div className="streaming-console-layout">
      <DigitalClock />
      
      <div className="transcription-container">
        {scriptTurns.length === 0 ? (
          <div className="console-box empty">
            <div className="waiting-placeholder">
              <span className="material-symbols-outlined icon">auto_stories</span>
              <p>Waiting for stream...</p>
            </div>
          </div>
        ) : (
          <div className="console-box videoke-mode">
            <div className="transcription-view subtitle-mode" ref={scrollRef}>
              {scriptTurns.map((t, i) => (
                <div key={t.id || i} className="subtitle-wrapper">
                  <SubtitleText text={t.text} translation={t.translation} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}