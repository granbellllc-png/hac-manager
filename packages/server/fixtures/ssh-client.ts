import { EventEmitter } from 'node:events';

/** In-process SSH protocol fixture. It never opens a socket. */
export class FixtureSshClient extends EventEmitter {
  static instances: FixtureSshClient[] = [];
  static connectMode: 'ready' | 'error' | 'close' | 'throw' | 'throw-string' =
    'ready';
  static execMode: 'success' | 'reject' | 'hang' | 'no-exit-code' = 'success';
  static sftpMode: 'success' | 'reject' = 'success';
  static readMode: 'success' | 'error' | 'hang' = 'success';
  static writeMode: 'success' | 'error' | 'hang' = 'success';
  static fingerprint: string | Buffer = 'SHA256:fixture-key';
  static files = new Map<string, string>();
  readonly channels: FixtureChannel[] = [];
  readonly streams: FixtureFileStream[] = [];
  config: Record<string, unknown> = {};
  ended = false;

  constructor() {
    super();
    FixtureSshClient.instances.push(this);
  }

  static reset() {
    this.instances = [];
    this.connectMode = 'ready';
    this.execMode = 'success';
    this.sftpMode = 'success';
    this.readMode = 'success';
    this.writeMode = 'success';
    this.fingerprint = 'SHA256:fixture-key';
    this.files.clear();
  }

  connect(config: Record<string, unknown>) {
    this.config = config;
    if (FixtureSshClient.connectMode === 'throw')
      throw new Error('fixture connect failure');
    if (FixtureSshClient.connectMode === 'throw-string')
      throw 'fixture connect failure';
    const accepted = (config.hostVerifier as (key: Buffer | string) => boolean)(
      FixtureSshClient.fingerprint,
    );
    queueMicrotask(() => {
      if (FixtureSshClient.connectMode === 'close') this.emit('close');
      else if (!accepted || FixtureSshClient.connectMode === 'error')
        this.emit('error', new Error('fixture handshake rejected'));
      else this.emit('ready');
    });
  }

  end() {
    this.ended = true;
    this.emit('close');
  }

  exec(
    _command: string,
    callback: (error: Error | null, stream?: FixtureChannel) => void,
  ) {
    if (FixtureSshClient.execMode === 'reject') {
      callback(new Error('fixture channel rejected'));
      return;
    }
    const stream = new FixtureChannel();
    this.channels.push(stream);
    callback(null, stream);
  }

  sftp(callback: (error: Error | null, wrapper?: object) => void) {
    if (FixtureSshClient.sftpMode === 'reject') {
      callback(new Error('fixture SFTP rejected'));
      return;
    }
    callback(null, {
      stat: (path: string, done: (error: Error | null) => void) =>
        done(FixtureSshClient.files.has(path) ? null : new Error('missing')),
      createReadStream: (path: string) => {
        const stream = new FixtureFileStream(path);
        this.streams.push(stream);
        queueMicrotask(() => {
          if (FixtureSshClient.readMode === 'error')
            stream.emit('error', new Error('fixture read failed'));
          else if (FixtureSshClient.readMode === 'success') {
            stream.emit(
              'data',
              Buffer.from(FixtureSshClient.files.get(path) ?? ''),
            );
            stream.emit('end');
          }
        });
        return stream;
      },
      createWriteStream: (path: string) => {
        const stream = new FixtureFileStream(path);
        this.streams.push(stream);
        return stream;
      },
    });
  }
}

class FixtureChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  input = '';
  write(input: string | Buffer) {
    this.input += String(input);
  }
  end() {
    queueMicrotask(() => {
      if (FixtureSshClient.execMode === 'hang') return;
      this.emit('data', Buffer.from(this.input || 'fixture-output'));
      this.stderr.emit('data', Buffer.from('fixture-stderr'));
      this.emit(
        'close',
        FixtureSshClient.execMode === 'no-exit-code' ? undefined : 0,
      );
      this.emit('close', 0);
    });
  }
}

class FixtureFileStream extends EventEmitter {
  destroyed = false;
  constructor(readonly path: string) {
    super();
  }
  destroy() {
    this.destroyed = true;
  }
  end(content: string) {
    queueMicrotask(() => {
      if (FixtureSshClient.writeMode === 'error') {
        this.emit('error', new Error('fixture write failed'));
        this.emit('error', new Error('fixture late write failure'));
      } else if (FixtureSshClient.writeMode === 'success') {
        FixtureSshClient.files.set(this.path, content);
        this.emit('finish');
        this.emit('close');
      }
    });
  }
}
