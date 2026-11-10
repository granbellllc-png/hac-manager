import { describe, expect, it } from 'vitest';
import { SecretRedactor } from '../redaction/index.js';
import {
  lastScriptOutputLine,
  looksLikeScriptPrompt,
  matchScriptAnswer,
  ScriptPromptSession,
  ScriptPromptStateError,
  stripAnsi,
} from './prompts.js';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi('\u001B[31mred\u001B[0m plain')).toBe('red plain');
    expect(stripAnsi('a\r\nb')).toBe('a\n\nb');
    expect(stripAnsi('\u001B[2K\u001B[1Gok')).toBe('ok');
  });

  it('leaves ordinary text alone', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('looksLikeScriptPrompt', () => {
  it('detects questions and trailing colons', () => {
    expect(looksLikeScriptPrompt('Enter the hostname:')).toBe(true);
    expect(looksLikeScriptPrompt('Continue? ')).toBe(true);
    expect(looksLikeScriptPrompt('\u001B[32mProceed:\u001B[0m')).toBe(true);
  });

  it('detects default-answer hints', () => {
    expect(looksLikeScriptPrompt('Install Docker? [y/N]')).toBe(true);
    expect(looksLikeScriptPrompt('Continue (y/n)')).toBe(true);
    expect(looksLikeScriptPrompt('Press Enter to continue')).toBe(true);
    expect(looksLikeScriptPrompt('Press any key')).toBe(true);
  });

  it('ignores log lines and empty output', () => {
    expect(looksLikeScriptPrompt('')).toBe(false);
    expect(looksLikeScriptPrompt('   \n')).toBe(false);
    expect(looksLikeScriptPrompt('[INFO] Downloading template')).toBe(false);
    expect(looksLikeScriptPrompt('[ERROR] failed:')).toBe(false);
    expect(looksLikeScriptPrompt('Creating container...')).toBe(false);
  });

  it('only inspects the last visible line', () => {
    expect(looksLikeScriptPrompt('Question:\nDone!')).toBe(false);
    expect(looksLikeScriptPrompt('log line\nContinue?')).toBe(true);
  });
});

describe('lastScriptOutputLine', () => {
  it('returns the last non-empty stripped line', () => {
    expect(lastScriptOutputLine('one\n\n  two:  \n')).toBe('two:');
    expect(lastScriptOutputLine('')).toBe('');
  });
});

describe('matchScriptAnswer', () => {
  it('returns undefined without configured answers', () => {
    expect(matchScriptAnswer('Continue?', undefined)).toBeUndefined();
    expect(matchScriptAnswer('Continue?', {})).toBeUndefined();
  });

  it('matches regular expressions case-insensitively', () => {
    expect(
      matchScriptAnswer('Enter the hostname:', { 'hostname:$': 'demo' }),
    ).toEqual({ pattern: 'hostname:$', response: 'demo' });
  });

  it('falls back to a literal match for invalid expressions', () => {
    expect(matchScriptAnswer('Choose [A] or [B]:', { '[': 'A' })).toEqual({
      pattern: '[',
      response: 'A',
    });
  });

  it('skips empty patterns and uses the first match', () => {
    expect(
      matchScriptAnswer('Password:', {
        '': 'no',
        password: 'one',
        '.*': 'two',
      }),
    ).toEqual({ pattern: 'password', response: 'one' });
  });
});

describe('ScriptPromptSession', () => {
  it('answers a matched prompt and clears the buffer', () => {
    const session = new ScriptPromptSession({
      answers: { 'Continue\\?': 'y' },
    });
    expect(session.feed('Installing\nContinue? ')).toEqual({ answers: ['y'] });
    expect(session.waiting).toBeUndefined();
  });

  it('pauses on an unexpected prompt and ignores later chunks', () => {
    const session = new ScriptPromptSession({
      answers: { 'Continue\\?': 'y' },
    });
    const feed = session.feed('API token:');
    expect(feed.answers).toEqual([]);
    expect(feed.prompt).toEqual({
      id: 'script-prompt-1',
      question: 'API token:',
    });
    expect(session.waiting?.question).toBe('API token:');
    expect(session.feed('\nmore output')).toEqual({ answers: [] });
    expect(session.waiting?.id).toBe('script-prompt-1');
  });

  it('redacts the question and accepts a custom id prefix', () => {
    const redactor = new SecretRedactor();
    redactor.register('hunter2');
    const session = new ScriptPromptSession({
      redactor,
      idPrefix: 'guest-100',
    });
    const feed = session.feed('Token hunter2:');
    expect(feed.prompt?.question).toBe('Token ***:');
    expect(feed.prompt?.id).toBe('guest-100-1');
  });

  it('resumes a paused prompt with the user answer', () => {
    const session = new ScriptPromptSession();
    session.feed('Username:');
    expect(session.respond('admin')).toBe('admin\n');
    expect(session.waiting).toBeUndefined();
  });

  it('rejects responding when no prompt is pending', () => {
    const session = new ScriptPromptSession();
    expect(() => session.respond('x')).toThrow(ScriptPromptStateError);
  });

  it('supports a custom prompt detector', () => {
    const session = new ScriptPromptSession({
      isPrompt: (text) => text.includes('<<'),
      answers: { '<<': 'ok' },
    });
    expect(session.feed('choose << ')).toEqual({ answers: ['ok'] });
  });
});
