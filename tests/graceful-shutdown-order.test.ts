import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('graceful shutdown lifecycle order', () => {
  test('stops intake and agents, terminalizes cards, then disconnects IM', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const shutdownStart = source.indexOf(
      'const shutdown = async (signal: string)',
    );
    const shutdownEnd = source.indexOf("process.on('SIGTERM'", shutdownStart);
    const shutdown = source.slice(shutdownStart, shutdownEnd);

    const rejectIntake = shutdown.indexOf('shuttingDown = true');
    const pauseInbound = shutdown.indexOf('imManager.pauseInbound()');
    const stopWeb = shutdown.indexOf('shutdownWebServer()');
    const stopAgents = shutdown.indexOf('queue\n        .shutdown(15_000)');
    const finalizeCards = shutdown.indexOf(
      "abortAllStreamingSessions('服务维护中')",
    );
    const disconnectIm = shutdown.indexOf('imManager\n      .disconnectAll()');

    for (const index of [
      rejectIntake,
      pauseInbound,
      stopWeb,
      stopAgents,
      finalizeCards,
      disconnectIm,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(rejectIntake).toBeLessThan(stopWeb);
    expect(rejectIntake).toBeLessThan(stopAgents);
    expect(rejectIntake).toBeLessThan(pauseInbound);
    expect(pauseInbound).toBeLessThan(stopWeb);
    expect(stopWeb).toBeLessThan(finalizeCards);
    expect(stopAgents).toBeLessThan(finalizeCards);
    expect(finalizeCards).toBeLessThan(disconnectIm);

    // A timeout race would reintroduce the disconnect-vs-finalize bug: the
    // abort promise would keep running after the transport had been closed.
    const cardPhase = shutdown.slice(finalizeCards, disconnectIm);
    expect(cardPhase).not.toContain('Promise.race');
  });
});
