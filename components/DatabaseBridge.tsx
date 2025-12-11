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

export default function DatabaseBridge() {
  const { client, connected, isAudioPlaying } = useLiveAPIContext();
  const { addTurn } = useLogStore();
  const { voiceStyle, speechRate } = useSettings();
  
  const lastProcessedIdRef = useRef<string | null>(null);
  const paragraphCountRef = useRef<number>(0);
  
  // Track audio state in a ref to access it inside the async loop
  const isAudioPlayingRef = useRef(isAudioPlaying);
  useEffect(() => {
    isAudioPlayingRef.current = isAudioPlaying;
  }, [isAudioPlaying]);

  const voiceStyleRef = useRef(voiceStyle);
  const speechRateRef = useRef(speechRate);

  useEffect(() => {
    voiceStyleRef.current = voiceStyle;
  }, [voiceStyle]);

  useEffect(() => {
    speechRateRef.current = speechRate;
  }, [speechRate]);

  // High-performance queue using Refs
  const queueRef = useRef<string[]>([]);
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

          const rawText = queueRef.current[0];
          const style = voiceStyleRef.current;
          
          let scriptedText = rawText;
          if (rawText !== '(clears throat)') {
             if (style === 'breathy') {
               scriptedText = `(soft inhale) ${rawText} ... (pause)`;
             } else if (style === 'dramatic') {
                scriptedText = `(slowly) ${rawText} ... (long pause)`;
             }
          }

          if (!scriptedText || !scriptedText.trim()) {
            queueRef.current.shift();
            continue;
          }

          // 1. Send text to model
          client.send([{ text: scriptedText }]);
          queueRef.current.shift();

          // 2. Wait for Audio to START (Model processing time)
          // Increased timeout to 10s to account for potential network/model latency
          let audioStarted = false;
          const waitStart = Date.now();
          while (Date.now() - waitStart < 10000) {
            if (isAudioPlayingRef.current) {
              audioStarted = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
          }

          // 3. Wait for Audio to FINISH (Playback time)
          if (audioStarted) {
             while (isAudioPlayingRef.current) {
               await new Promise(resolve => setTimeout(resolve, 100));
             }
          }

          // 4. Enforce 1 second gap after audio completes
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Removed the '(stop)' signal here as it may disrupt continuous sessions or state.
        // The model will simply wait for the next input.

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
           queueRef.current.push(seg);
           paragraphCountRef.current += 1;
           if (paragraphCountRef.current > 0 && paragraphCountRef.current % 3 === 0) {
              queueRef.current.push('(clears throat)');
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
  }, [connected, client, addTurn]); // Removed isAudioPlaying from deps to avoid loop restarts

  return null;
}