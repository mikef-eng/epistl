import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { QuicClientError, quicPing } from 'quic-relay-client';

/**
 * Dev-only spike screen (issue #67): calls the generated `quicPing`
 * TurboModule function -- produced by `uniffi-bindgen-react-native` from
 * `packages/quic-relay-client`'s single UniFFI-annotated async function --
 * against a throwaway local Quinn QUIC echo server
 * (`apps/api/examples/quic_echo_server.rs`), and renders either the decoded
 * echoed response or the typed failure that came back.
 *
 * Reachable only via a temporary, `__DEV__`-gated navigation entry (see
 * `LoginScreen.tsx` and `App.tsx`) -- never added to `ChatScreen.tsx` or
 * any real, authenticated app flow. See issue #67 and
 * `docs/superpowers/specs/2026-09-13-quic-quinn-transport-design.md`.
 */
export default function QuicSpikeScreen() {
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('4433');
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  const [resultText, setResultText] = useState<string | null>(null);

  const isPortValid = /^\d{1,5}$/.test(port) && Number(port) <= 65535;
  const isSubmitDisabled = host.trim().length === 0 || !isPortValid || status === 'pending';

  async function handlePing() {
    if (isSubmitDisabled) {
      return;
    }

    setStatus('pending');
    setResultText(null);
    try {
      const response = await quicPing(host.trim(), Number(port));
      setStatus('success');
      setResultText(`Echoed ${response.byteLength} byte(s): "${bytesToAsciiString(response)}"`);
    } catch (err) {
      setStatus('error');
      setResultText(describeQuicClientError(err));
    }
  }

  return (
    <View className="flex-1 justify-center bg-white px-6">
      <Text className="mb-2 text-center text-2xl font-bold text-blue-500">QUIC spike</Text>
      <Text className="mb-6 text-center text-sm text-gray-500">
        Dev-only (issue #67). Run{'\n'}
        `cargo run --example quic_echo_server --manifest-path apps/api/Cargo.toml`{'\n'}
        locally first, then tap Ping.
      </Text>

      <TextInput
        className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
        placeholder="Host"
        autoCapitalize="none"
        autoCorrect={false}
        value={host}
        onChangeText={setHost}
      />
      <TextInput
        className="mb-4 rounded-lg border border-gray-300 px-4 py-3 text-base"
        placeholder="Port"
        keyboardType="number-pad"
        value={port}
        onChangeText={setPort}
      />

      <Pressable
        accessibilityRole="button"
        disabled={isSubmitDisabled}
        onPress={handlePing}
        className={`mb-4 items-center rounded-lg py-3 ${
          isSubmitDisabled ? 'bg-blue-200' : 'bg-blue-500'
        }`}
      >
        <Text className="text-base font-semibold text-white">
          {status === 'pending' ? 'Pinging…' : 'Ping'}
        </Text>
      </Pressable>

      {resultText !== null ? (
        <Text className={`text-center ${status === 'error' ? 'text-red-500' : 'text-green-600'}`}>
          {resultText}
        </Text>
      ) : null}
    </View>
  );
}

function bytesToAsciiString(buffer: ArrayBuffer): string {
  // Hermes doesn't ship `TextDecoder` (see this crate's own generated
  // `quic_relay_client.ts`'s comment on the same point), and the spike's
  // echoed payload is always the ASCII bytes `"ping"`, so a byte-by-byte
  // `String.fromCharCode` is enough here -- no need for a TextDecoder
  // polyfill on this throwaway dev screen.
  return String.fromCharCode(...new Uint8Array(buffer));
}

function describeQuicClientError(err: unknown): string {
  if (QuicClientError.instanceOf(err)) {
    if (QuicClientError.ConnectionFailed.instanceOf(err)) {
      return `ConnectionFailed: ${err.inner.message}`;
    }
    if (QuicClientError.StreamIoFailed.instanceOf(err)) {
      return `StreamIoFailed: ${err.inner.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
