/**
 * Copyright IBM Corp. 2019, 2019
 *
 * This source code is licensed under the Apache-2.0 license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const { babel } = require('@rollup/plugin-babel');
const { camelCase } = require('change-case');
const fs = require('fs-extra');
const path = require('path');
const { rollup } = require('rollup');
const virtual = require('../plugins/virtual');

const BANNER = `/**
 * Copyright IBM Corp. 2019, 2020
 *
 * This source code is licensed under the Apache-2.0 license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Code generated by @carbon/icon-build-helpers. DO NOT EDIT.
 */`;
const external = ['@carbon/icon-helpers', 'react', 'prop-types'];
const babelConfig = {
  babelrc: false,
  exclude: /node_modules/,
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          browsers: ['extends browserslist-config-carbon'],
        },
      },
    ],
    '@babel/preset-react',
  ],
  plugins: [
    '@babel/plugin-transform-react-constant-elements',
    'babel-plugin-dev-expression',
  ],
  babelHelpers: 'bundled',
};

async function builder(metadata, { output }) {
  // Using the metadata, we can build up a list of modules that we want included
  // in the different bundles we ship.
  //
  // For each module, we need to create two ways of consuming it. The first way
  // is as a dedicated module, the second as a single function that we could
  // export in an entrypoint.
  const modules = metadata.icons.flatMap((icon) => {
    return icon.output.map((size) => {
      return {
        source: createIconFlatExport(
          size.moduleName,
          size.descriptor,
          icon.deprecated
        ),
        entrypoint: createIconEntrypoint(
          size.moduleName,
          size.descriptor,
          icon.deprecated
        ),
        filepath: size.filepath,
        moduleName: size.moduleName,
      };
    });
  });

  // Given the current size of our icons (~5000 modules) we need to split up the
  // entrypoint into chunks. In the past, we tried re-exporting from the source
  // but this ended up causing slowdowns due to module resolution.
  //
  // As a result, we sort our list of modules into buckets and generate
  // entrypoints based on those. Then, the root `index.js` file re-exports from
  // these entrypoints. This is a hybrid approach between a single entrypoint
  // that is too big for most tooling, and a re-export strategy that takes too
  // long due to the number of modules along with the time it takes tooling to
  // process them.
  const BUCKET_SIZE = 250;
  const BUCKET_COUNT = Math.ceil(modules.length / BUCKET_SIZE);
  const buckets = Array(BUCKET_COUNT);

  for (let i = 0; i < buckets.length; i++) {
    const start = BUCKET_SIZE * i;
    const end = Math.min(start + BUCKET_SIZE, modules.length) - 1;
    const bucket = Array(end - start + 1);

    for (let j = start; j <= end; j++) {
      bucket[j - start] = modules[j];
    }

    buckets[i] = bucket;
  }

  const files = {
    'index.js': `${BANNER}\n\nexport { default as Icon } from './Icon.js';`,
  };
  const input = {
    'index.js': 'index.js',
  };
  for (const m of modules) {
    files[m.filepath] = m.entrypoint;
    input[m.filepath] = m.filepath;
  }

  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    const filename = `__generated__/bucket-${i}.js`;

    input[filename] = filename;
    files[filename] = `${BANNER}

import React from 'react';
import Icon from './Icon.js';

const didWarnAboutDeprecation = {};`;

    for (const m of bucket) {
      files[filename] += `export ${m.source}`;
      files['index.js'] += `export { ${m.moduleName} } from '${filename}';`;
    }
  }

  const bundle = await rollup({
    input: input,
    external,
    plugins: [
      virtual({
        './Icon.js': await fs.readFile(
          path.resolve(__dirname, './components/Icon.js'),
          'utf8'
        ),
        ...files,
      }),
      babel(babelConfig),
    ],
  });

  const bundles = [
    {
      directory: path.join(output, 'es'),
      format: 'esm',
    },
    {
      directory: path.join(output, 'lib'),
      format: 'commonjs',
    },
  ];

  for (const { directory, format } of bundles) {
    const outputOptions = {
      dir: directory,
      format,
      entryFileNames: '[name]',
      banner: BANNER,
      exports: 'auto',
    };

    await bundle.write(outputOptions);

    const delDirs = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (dirent) => dirent.isDirectory() && dirent.name !== '__generated__'
      )
      .map((dirent) => dirent.name);

    delDirs.forEach((d) => {
      fs.rmSync(path.join(directory, d), { recursive: true, force: true });
    });
  }

  const umd = await rollup({
    input: 'index.js',
    external,
    plugins: [
      virtual({
        './Icon.js': await fs.readFile(
          path.resolve(__dirname, './components/Icon.js'),
          'utf8'
        ),
        ...files,
      }),
      babel(babelConfig),
    ],
  });

  await umd.write({
    file: path.join(output, 'umd/index.js'),
    format: 'umd',
    name: 'CarbonIconsReact',
    globals: {
      '@carbon/icon-helpers': 'CarbonIconHelpers',
      'prop-types': 'PropTypes',
      react: 'React',
    },
  });
}

/**
 * Convert the given node to a JSX string source
 * @param {object} node
 * @returns {string}
 */
function convertToJSX(node) {
  const { elem, attrs } = node;
  return `<${elem} ${formatAttributes(attrs)} />`;
}

const attributeDenylist = ['data', 'aria'];

/**
 * Determine if the given attribute should be transformed when being converted
 * to a React prop or if we should pass it through as-is
 * @param {string} attribute
 * @returns {boolean}
 */
function shouldTransformAttribute(attribute) {
  return attributeDenylist.every((prefix) => !attribute.startsWith(prefix));
}

/**
 * Serialize a given object of key, value pairs to an JSX-compatible string
 * @param {object} attrs
 * @returns {string}
 */
function formatAttributes(attrs) {
  return Object.keys(attrs).reduce((acc, key, index) => {
    const attribute = shouldTransformAttribute(key)
      ? `${camelCase(key)}="${attrs[key]}"`
      : `${key}="${attrs[key]}"`;

    if (index === 0) {
      return attribute;
    }
    return acc + ' ' + attribute;
  }, '');
}

function createIconFlatExport(moduleName, descriptor, isDeprecated = false) {
  const deprecatedBlock = isDeprecated
    ? `
    if (__DEV__) {
      if (!didWarnAboutDeprecation['${moduleName}']) {
        didWarnAboutDeprecation['${moduleName}'] = true;
        console.warn(
          \`The ${moduleName} component has been deprecated and will be \` +
          \`removed in the next major version of @carbon/icons-react.\`
        );
      }
    }
    `
    : '';
  return createIconSource(moduleName, descriptor, deprecatedBlock);
}

function createIconEntrypoint(moduleName, descriptor, isDeprecated = false) {
  const deprecatedPreamble = isDeprecated
    ? 'let didWarnAboutDeprecation = false;'
    : '';
  const deprecatedBlock = isDeprecated
    ? `
    if (__DEV__) {
      if (!didWarnAboutDeprecation) {
        didWarnAboutDeprecation = true;
        console.warn(
          \`The ${moduleName} component has been deprecated and will be \` +
          \`removed in the next major version of @carbon/icons-react.\`
        );
      }
    }
    `
    : '';
  const source = createIconSource(moduleName, descriptor, deprecatedBlock);
  return `${BANNER}
import React from 'react';
import Icon from './Icon.js';
${deprecatedPreamble}
${source}
export default ${moduleName};
`;
}

/**
 * Generate an icon component, which in our case is the string representation
 * of the component, from a given moduleName and icon descriptor.
 * @param {string} moduleName
 * @param {object} descriptor
 * @param {string} customBlock
 */
function createIconSource(moduleName, descriptor, customBlock = '') {
  const { attrs, content } = descriptor;
  const { width, height, viewBox, ...rest } = attrs;
  return `
    const ${moduleName} = /*#__PURE__*/ React.forwardRef(
      function ${moduleName}({ children, ...rest }, ref) {
        ${customBlock}
        return (
          <Icon
            width={${width}}
            height={${height}}
            viewBox="${viewBox}"
            ${formatAttributes(rest)}
            ref={ref}
            {...rest}>
            ${content.map(convertToJSX).join('\n')}
            {children}
          </Icon>
        );
      }
    );
  `;
}

module.exports = builder;
