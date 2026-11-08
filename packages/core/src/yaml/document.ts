import {
  parseDocument,
  type Document,
  type ParseOptions,
  type DocumentOptions,
  type SchemaOptions,
} from 'yaml';
import { customYamlTags } from './tags.js';

export function loadYamlDocument(
  text: string,
  options?: ParseOptions & DocumentOptions & SchemaOptions,
): Document {
  return parseDocument(text, {
    customTags: customYamlTags,
    keepSourceTokens: true,
    ...options,
  });
}

export function dumpYamlDocument(
  document: Document,
  options?: { readonly eol?: '\n' | '\r\n' },
): string {
  const rendered = document.toString();
  const eol = options?.eol ?? '\n';
  return eol === '\r\n'
    ? rendered.replace(/\r?\n/g, '\r\n')
    : rendered.replace(/\r\n/g, '\n');
}

export function yamlDocumentToJS<T = unknown>(document: Document): T {
  return document.toJS() as T;
}
