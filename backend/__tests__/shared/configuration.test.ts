import {
  ensureBaseConfiguration,
  resolveRetrieverProvider,
} from '../../src/shared/configuration.js';

describe('resolveRetrieverProvider', () => {
  it('defaults to supabase when nothing is configured', () => {
    expect(resolveRetrieverProvider(undefined, {})).toBe('supabase');
  });

  it('uses RETRIEVER_PROVIDER from the environment (how the AWS deployment selects pgvector)', () => {
    expect(
      resolveRetrieverProvider(undefined, { RETRIEVER_PROVIDER: 'pgvector' }),
    ).toBe('pgvector');
  });

  it('lets an explicit per-run value override the environment', () => {
    expect(
      resolveRetrieverProvider('supabase', { RETRIEVER_PROVIDER: 'pgvector' }),
    ).toBe('supabase');
  });

  it('throws on an unknown provider instead of silently falling back', () => {
    expect(() => resolveRetrieverProvider('pinecone', {})).toThrow(
      /Unsupported retriever provider: pinecone/,
    );
    expect(() =>
      resolveRetrieverProvider(undefined, { RETRIEVER_PROVIDER: 'typo' }),
    ).toThrow(/Expected one of: supabase, pgvector/);
  });
});

describe('ensureBaseConfiguration', () => {
  const original = process.env.RETRIEVER_PROVIDER;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.RETRIEVER_PROVIDER;
    } else {
      process.env.RETRIEVER_PROVIDER = original;
    }
  });

  it('keeps existing defaults for k and filterKwargs', () => {
    delete process.env.RETRIEVER_PROVIDER;
    expect(ensureBaseConfiguration({})).toEqual({
      retrieverProvider: 'supabase',
      filterKwargs: {},
      k: 5,
    });
  });

  it('picks up pgvector from the environment', () => {
    process.env.RETRIEVER_PROVIDER = 'pgvector';
    expect(ensureBaseConfiguration({}).retrieverProvider).toBe('pgvector');
  });

  it('prefers the configurable value over the environment', () => {
    process.env.RETRIEVER_PROVIDER = 'pgvector';
    expect(
      ensureBaseConfiguration({ configurable: { retrieverProvider: 'supabase' } })
        .retrieverProvider,
    ).toBe('supabase');
  });
});
