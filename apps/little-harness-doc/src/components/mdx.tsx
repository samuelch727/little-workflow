import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { ApiField, ApiParameters, ApiTypeBlock } from '@/components/api-reference';
import { Mermaid } from '@/components/mermaid';

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ApiField,
    ApiParameters,
    ApiTypeBlock,
    Mermaid,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
