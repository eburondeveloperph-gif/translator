/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GenAILiveClient } from '../../lib/genai-live-client';
import { LiveConnectConfig, Modality, LiveServerToolCall } from '@google/genai';
import { AudioStreamer } from '../../lib/audio-streamer';
import { audioContext } from '../../lib/utils';
import VolMeterWorket from '../../lib/worklets/vol-meter';
import { useLogStore, useSettings } from '@/lib/state';
import { SPEAKER_VOICE_MAP } from '@/lib/constants';

export type UseLiveApiResults = {
  client: GenAILiveClient;
  setConfig: (config: LiveConnectConfig) => void;
  config: LiveConnectConfig;

  connect: () => Promise<void>;
  disconnect: () => void;
  connected: boolean;

  volume: number;
  isVolumeEnabled: boolean;
  setIsVolumeEnabled: (isEnabled: boolean) => void;
  isAudioPlaying: boolean;
  getAudioStreamerState: () => { duration: number; endOfQueueTime: number };
  
  // Multi-speaker support
  sendToSpeaker: (text: string, speaker: string) => void;
  addOutputListener: (callback: (text: string, isFinal: boolean) => void) => () => void;
};

export function useLiveApi({
  apiKey,
}: {
  apiKey: string;
}): UseLiveApiResults {
  const { model, backgroundPadEnabled, backgroundPadVolume } = useSettings();
  
  // Main client (default voice/settings)
  const client = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  
  // Dedicated Speaker Clients
  const male1 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  const male2 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  const female1 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);
  const female2 = useMemo(() => new GenAILiveClient(apiKey, model), [apiKey, model]);

  const audioStreamerRef = useRef<AudioStreamer | null>(null);

  const [volume, setVolume] = useState(0);
  const [isVolumeEnabled, setIsVolumeEnabled] = useState(true);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConnectConfig>({});

  // register audio for streaming server -> speakers
  useEffect(() => {
    if (!audioStreamerRef.current) {
      audioContext({ id: 'audio-out' }).then((audioCtx: AudioContext) => {
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        // Apply initial volume state
        audioStreamerRef.current.gainNode.gain.value = isVolumeEnabled ? 1 : 0;
        
        // Sync initial pad state
        if (backgroundPadEnabled) {
          audioStreamerRef.current.startPad(backgroundPadVolume);
        }

        // Bind playback state callbacks
        audioStreamerRef.current.onPlay = () => setIsAudioPlaying(true);
        audioStreamerRef.current.onComplete = () => setIsAudioPlaying(false);

        audioStreamerRef.current
          .addWorklet<any>('vumeter-out', VolMeterWorket, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            // Successfully added worklet
          })
          .catch(err => {
            console.error('Error adding worklet:', err);
          });
      });
    }
  }, [audioStreamerRef]);

  // Sync background pad settings
  useEffect(() => {
    if (!audioStreamerRef.current) return;
    
    if (backgroundPadEnabled) {
      audioStreamerRef.current.startPad(backgroundPadVolume);
    } else {
      audioStreamerRef.current.stopPad();
    }
  }, [backgroundPadEnabled]);

  useEffect(() => {
    if (audioStreamerRef.current && backgroundPadEnabled) {
      audioStreamerRef.current.setPadVolume(backgroundPadVolume);
    }
  }, [backgroundPadVolume]);

  // Sync volume enabled state with gain node
  useEffect(() => {
    if (audioStreamerRef.current) {
      audioStreamerRef.current.gainNode.gain.value = isVolumeEnabled ? 1 : 0;
    }
  }, [isVolumeEnabled]);

  useEffect(() => {
    const onOpen = () => setConnected(true);
    const onClose = () => setConnected(false);
    
    // Stop streamer if main client is interrupted
    const stopAudioStreamer = () => {
      if (audioStreamerRef.current) {
        audioStreamerRef.current.stop();
      }
    };

    // Centralized audio handler for all clients
    const onAudio = (data: ArrayBuffer) => {
      if (audioStreamerRef.current) {
        audioStreamerRef.current.addPCM16(new Uint8Array(data));
      }
    };

    // Bind event listeners to Main Client
    client.on('open', onOpen);
    client.on('close', onClose);
    client.on('interrupted', stopAudioStreamer);
    client.on('audio', onAudio);

    // Bind audio listeners to Speaker Clients
    male1.on('audio', onAudio);
    male2.on('audio', onAudio);
    female1.on('audio', onAudio);
    female2.on('audio', onAudio);

    // Note: We only attach tool call handlers to the main client for now to keep the demo simple,
    // assuming complex interactions happen via the primary channel or tool logic is shared.
    // However, basic TTS audio routing is enabled for all.
    
    // Only attaching tool handling to the main client for this demo scope
    const onToolCall = (toolCall: LiveServerToolCall) => {
      const functionResponses: any[] = [];
      for (const fc of toolCall.functionCalls) {
        const triggerMessage = `Triggering function call: **${fc.name}**\n\`\`\`json\n${JSON.stringify(fc.args, null, 2)}\n\`\`\``;
        useLogStore.getState().addTurn({ role: 'system', text: triggerMessage, isFinal: true });
        functionResponses.push({ id: fc.id, name: fc.name, response: { result: 'ok' } });
      }
      if (functionResponses.length > 0) {
        const responseMessage = `Function call response:\n\`\`\`json\n${JSON.stringify(functionResponses, null, 2)}\n\`\`\``;
        useLogStore.getState().addTurn({ role: 'system', text: responseMessage, isFinal: true });
      }
      client.sendToolResponse({ functionResponses: functionResponses });
    };

    client.on('toolcall', onToolCall);

    return () => {
      // Clean up event listeners
      client.off('open', onOpen);
      client.off('close', onClose);
      client.off('interrupted', stopAudioStreamer);
      client.off('audio', onAudio);
      client.off('toolcall', onToolCall);
      
      male1.off('audio', onAudio);
      male2.off('audio', onAudio);
      female1.off('audio', onAudio);
      female2.off('audio', onAudio);
    };
  }, [client, male1, male2, female1, female2]);

  const connect = useCallback(async () => {
    if (!config) {
      throw new Error('config has not been set');
    }
    
    // Disconnect all first
    client.disconnect();
    male1.disconnect();
    male2.disconnect();
    female1.disconnect();
    female2.disconnect();
    
    // Resume audio context
    if (audioStreamerRef.current) {
      try {
        await audioStreamerRef.current.resume();
        if (backgroundPadEnabled) {
          audioStreamerRef.current.startPad(backgroundPadVolume);
        }
      } catch (e) {
        console.warn('Failed to resume audio context:', e);
      }
    }
    
    // Create config helper
    const getSpeakerConfig = (voiceName: string): LiveConnectConfig => ({
      ...config,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName
          }
        }
      }
    });

    // Connect ALL clients
    await Promise.all([
      client.connect(config),
      male1.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Male 1'])),
      male2.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Male 2'])),
      female1.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Female 1'])),
      female2.connect(getSpeakerConfig(SPEAKER_VOICE_MAP['Female 2'])),
    ]);

  }, [client, male1, male2, female1, female2, config, backgroundPadEnabled, backgroundPadVolume]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    male1.disconnect();
    male2.disconnect();
    female1.disconnect();
    female2.disconnect();
    setConnected(false);
  }, [setConnected, client, male1, male2, female1, female2]);

  const getAudioStreamerState = useCallback(() => {
    return {
      duration: audioStreamerRef.current?.duration || 0,
      endOfQueueTime: audioStreamerRef.current?.endOfQueueTime || 0,
    };
  }, []);

  // Send text to specific speaker client
  const sendToSpeaker = useCallback((text: string, speaker: string) => {
    switch(speaker) {
      case 'Male 1':
        male1.send([{ text }]);
        break;
      case 'Male 2':
        male2.send([{ text }]);
        break;
      case 'Female 1':
        female1.send([{ text }]);
        break;
      case 'Female 2':
        female2.send([{ text }]);
        break;
      default:
        client.send([{ text }]);
    }
  }, [client, male1, male2, female1, female2]);

  // Aggregate output listeners
  const addOutputListener = useCallback((callback: (text: string, isFinal: boolean) => void) => {
    const handler = (text: string, isFinal: boolean) => callback(text, isFinal);
    
    client.on('outputTranscription', handler);
    male1.on('outputTranscription', handler);
    male2.on('outputTranscription', handler);
    female1.on('outputTranscription', handler);
    female2.on('outputTranscription', handler);

    return () => {
      client.off('outputTranscription', handler);
      male1.off('outputTranscription', handler);
      male2.off('outputTranscription', handler);
      female1.off('outputTranscription', handler);
      female2.off('outputTranscription', handler);
    };
  }, [client, male1, male2, female1, female2]);

  return {
    client,
    config,
    setConfig,
    connect,
    connected,
    disconnect,
    volume,
    isVolumeEnabled,
    setIsVolumeEnabled,
    isAudioPlaying,
    getAudioStreamerState,
    sendToSpeaker,
    addOutputListener,
  };
}