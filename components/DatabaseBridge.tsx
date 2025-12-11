/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { useEffect, useRef } from 'react';
import { supabase, Transcript } from '../lib/supabase';
import { useLiveAPIContext } from '../contexts/LiveAPIContext';
import { useLogStore, useSettings } from '../lib/state';

// Worker script to ensure polling continues even when tab is in background
const workerScript = `
  self.onmessage = function() {
    setInterval(() => {
      self.postMessage('tick');
    }, 5000);
  };
`;

// Helper to segment text into natural reading chunks (Paragraphs)
const segmentText = (text: string): string[] => {
  if (!text) return [];
  return text.split(/\r?\n+/).map(t => t.trim()).filter(t => t.length > 0);
};

type QueueItem = {
  text: string;
  refData: Transcript | null; // null if system message like (clears throat)
};

export default function DatabaseBridge() {
  const { client, connected, getAudioStreamerState, sendToSpeaker, addOutputListener } = useLiveAPIContext();
  const { addTurn } = useLogStore();
  const { voiceStyle, speechRate, language } = useSettings();
  
  const lastProcessedIdRef = useRef<string | null>(null);
  const paragraphCountRef = useRef<number>(0);
  
  const voiceStyleRef = useRef(voiceStyle);
  const speechRateRef = useRef(speechRate);
  const languageRef = useRef(language);

  // Buffer to capture incoming translations for the current turn
  const currentTranslationBufferRef = useRef<string>('');

  useEffect(() => {
    voiceStyleRef.current = voiceStyle;
  }, [voiceStyle]);

  useEffect(() => {
    speechRateRef.current = speechRate;
  }, [speechRate]);

  useEffect(() => {
    languageRef.current = language;
  }, [language]);

  // Hook up listener to capture the model's spoken response text
  // Using new multi-client listener
  useEffect(() => {
    const removeListener = addOutputListener((text: string, isFinal: boolean) => {
       currentTranslationBufferRef.current += text;
    });
    return () => {
       removeListener();
    };
  }, [addOutputListener]);

  // High-performance queue using Refs
  const queueRef = useRef<QueueItem[]>([]);
  const isProcessingRef = useRef(false);

  // Data Ingestion & Processing Logic
  useEffect(() => {
    isProcessingRef.current = false;

    if (!connected) return;

    // The consumer loop that processes the queue sequentially (Closed Loop Control)
    const processQueueLoop = async () => {
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;

      try {
        while (queueRef.current.length > 0) {
          // Safety check
          if (client.status !== 'connected') {
            isProcessingRef.current = false;
            return;
          }

          const item = queueRef.current[0];
          const rawText = item.text;
          
          // Detect Speaker
          let textToSend = rawText;
          let targetSpeaker = 'default';
          
          if (rawText.startsWith('Male 1:')) {
            targetSpeaker = 'Male 1';
            textToSend = rawText.replace('Male 1:', '').trim();
          } else if (rawText.startsWith('Male 2:')) {
             targetSpeaker = 'Male 2';
             textToSend = rawText.replace('Male 2:', '').trim();
          } else if (rawText.startsWith('Female 1:')) {
             targetSpeaker = 'Female 1';
             textToSend = rawText.replace('Female 1:', '').trim();
          } else if (rawText.startsWith('Female 2:')) {
             targetSpeaker = 'Female 2';
             textToSend = rawText.replace('Female 2:', '').trim();
          }
          
          const style = voiceStyleRef.current;
          let scriptedText = textToSend;
          
          // Apply Voice Style only to non-command text
          if (textToSend !== '(clears throat)') {
             switch (style) {
               case 'breathy':
                 scriptedText = `(soft inhale) ${textToSend} ... (pause)`;
                 break;
               case 'dramatic':
                 scriptedText = `(slowly) ${textToSend} ... (long pause)`;
                 break;
               case 'enthusiastic':
                 scriptedText = `(excitedly) ${textToSend}`;
                 break;
               case 'formal':
                 scriptedText = `(professionally) ${textToSend}`;
                 break;
               case 'conversational':
                 scriptedText = `(casually) ${textToSend}`;
                 break;
               // 'natural' adds no stage directions
             }
          }

          if (!scriptedText || !scriptedText.trim()) {
            queueRef.current.shift();
            continue;
          }

          // Reset translation buffer for this new segment
          currentTranslationBufferRef.current = '';

          // Capture audio state BEFORE sending
          const preSendState = getAudioStreamerState();

          // 1. Send text to correct model
          sendToSpeaker(scriptedText, targetSpeaker);
          queueRef.current.shift();

          // 2. Wait for Audio to ARRIVE (Scheduled Time Increases)
          const waitStart = Date.now();
          let audioArrived = false;
          while (Date.now() - waitStart < 15000) {
             const currentState = getAudioStreamerState();
             if (currentState.endOfQueueTime > preSendState.endOfQueueTime + 0.1) {
                audioArrived = true;
                break;
             }
             await new Promise(resolve => setTimeout(resolve, 100));
          }

          if (!audioArrived) {
            console.warn("Timeout waiting for audio response from model. Moving to next chunk.");
          }

          // 3. Pipelining Wait: Wait until remaining audio duration is < 3 seconds
          while (true) {
             const state = getAudioStreamerState();
             if (state.duration < 3.0) {
                break;
             }
             await new Promise(resolve => setTimeout(resolve, 200));
          }

          // 4. Save Translation to Supabase
          if (item.refData && currentTranslationBufferRef.current.trim().length > 0) {
            try {
              await supabase.from('translations').insert({
                meeting_id: item.refData.session_id,
                user_id: item.refData.user_id,
                original_text: rawText, 
                translated_text: currentTranslationBufferRef.current.trim(),
                language: languageRef.current,
              });
            } catch (err) {
              console.error('Failed to save translation:', err);
            }
          }
        }
      } catch (e) {
        console.error('Error in processing loop:', e);
      } finally {
        isProcessingRef.current = false;
      }
    };

    if (queueRef.current.length > 0) {
      processQueueLoop();
    }

    const processNewData = (data: Transcript) => {
      const source = data.full_transcript_text;
      if (!data || !source) return;

      if (lastProcessedIdRef.current === data.id) return;
      lastProcessedIdRef.current = data.id;
      
      // Update UI
      addTurn({
        role: 'system',
        text: source, 
        sourceText: source, 
        isFinal: true
      });

      // Queue Paragraphs
      const segments = segmentText(source);
      if (segments.length > 0) {
        segments.forEach(seg => {
           queueRef.current.push({ text: seg, refData: data });
           
           paragraphCountRef.current += 1;
           if (paragraphCountRef.current > 0 && paragraphCountRef.current % 3 === 0) {
              queueRef.current.push({ text: '(clears throat)', refData: null });
           }
        });
        processQueueLoop();
      }
    };

    const fetchLatest = async () => {
      const { data, error } = await supabase
        .from('transcripts')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();
      
      if (!error && data) {
        processNewData(data as Transcript);
      }
    };

    // Initialize Web Worker for background polling
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = () => {
      fetchLatest();
    };
    worker.postMessage('start');

    // Setup Realtime Subscription
    const channel = supabase
      .channel('bridge-realtime-opt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transcripts' },
        (payload) => {
          if (payload.new) {
             processNewData(payload.new as Transcript);
          }
        }
      )
      .subscribe();

    fetchLatest();

    return () => {
      worker.terminate();
      supabase.removeChannel(channel);
    };
  }, [connected, client, addTurn, getAudioStreamerState, sendToSpeaker, addOutputListener]);

  return null;
}