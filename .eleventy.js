/*
 * Copyright 2020-2022 G-Labs. All Rights Reserved.
 *         https://zuixjs.github.io/zuix
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 *
 *  This file is part of
 *  zUIx, Javascript library for component-based development.
 *        https://zuixjs.github.io/zuix
 *
 * @author Generoso Martello <generoso@martello.com>
 * @version 1.0
 *
 */

const path = require('path');
const config = require('config');
const util = require('util');
const compress = require('compression');
const chokidar = require('chokidar');

// 11ty
const {EleventyRenderPlugin} = require("@11ty/eleventy");

// zuix.js CLI utils
const zuixCompile = require('zuix/commands/compile-page');
const zuixUtils = require('zuix/common/utils');

// Read configuration either from './config/{default}.json'
// or './config/production.json' based on current `NODE_ENV'
// environment variable value
let zuixConfig = config.get('zuix');
const sourceFolder = zuixConfig.get('build.input');
const buildFolder = zuixConfig.get('build.output');
const dataFolder = zuixConfig.get('build.dataFolder');
const includesFolder = zuixConfig.get('build.includesFolder');
const copyFiles = zuixConfig.get('build.copy');
const ignoreFiles = zuixConfig.get('build.ignore');
const componentsFolders = zuixConfig.get('build.componentsFolders');

// LESS CSS compiler
const less = require('less');
const lessConfig = require(process.cwd() + '/.lessrc');

// Linter (ESLint)
const Linter = require('eslint').Linter;
const linter = new Linter();
const lintConfig = require(process.cwd() + '/.eslintrc');

// Minifier
//const { minify } = require("terser");
const fs = require('fs');
const {render} = require('template-file');

// Keep track of changed files for zUIx.js post-processing
const postProcessFiles = [];
const changedFiles = [];
let browserSync;
let rebuildAll = true;
// - copy last zUIx release
zuixUtils.copyFolder(util.format('%s/node_modules/zuix-dist/js', process.cwd()), util.format('%s/js/zuix', buildFolder), (err) => {
  if (err) console.log(err);
});
// - auto-generated config.js
zuixUtils.generateAppConfig(zuixConfig);
// replace {{variables}} used in the config
zuixConfig = JSON.parse(render(JSON.stringify(zuixConfig), zuixConfig));

module.exports = function(eleventyConfig) {
  eleventyConfig.setWatchJavaScriptDependencies(false);
  eleventyConfig.addPlugin(EleventyRenderPlugin);

  // Add ignores
  [...ignoreFiles, ...componentsFolders].forEach((f) => {
    f = path.join(sourceFolder, f);
    eleventyConfig.ignores.add(f);
    console.log('Adding ignore "%s"', f);
  });
  // Copy base files
  copyFiles.forEach((f) => {
    f = path.join(sourceFolder, f);
    eleventyConfig.addPassthroughCopy(f);
    console.log('Adding copy "%s"', f);
  });

  // from https://github.com/kkgthb/web-site-11ty-03-netlify-function/blob/main/.eleventy.js
  // See if this helps with things that do not refresh
  //module.exports = function (eleventyConfig) {
  //  eleventyConfig.setUseGitIgnore(false);
  //};
  // Make Liquid capable of rendering "partials"
  eleventyConfig.setLiquidOptions({
    cache: false,
    dynamicPartials: true,
    strictFilters: false,
  });

  // Add custom file types and handlers
  eleventyConfig.addTemplateFormats([ 'less', 'css', 'js' ]);
  eleventyConfig.addExtension('less', {
    read: true,
    outputFileExtension: 'css',
    compile: (content, path) => () => {
        let output;
        less.render(content, lessConfig, function(error, lessOutput) {
          // TODO: handle and report 'error'
          output = lessOutput;
        });
        return output.css;
      }
  });
  // Add linter to report code errors
  eleventyConfig.addLinter('eslint', function(content, inputPath, outputPath) {
    if( inputPath.endsWith('.js') ) {
      // TODO: collect and report at the end of the build (inside 'afterBuild' event handler)
      const issues = linter.verify(content, lintConfig, inputPath);
      if (issues.length > 0) {
        console.log('[11ty] "%s" linter result', inputPath)
      }
      issues.forEach(function(m) {
        if (m.fatal || m.severity > 1) {
          console.error('       Error: %s (%s:%s)', m.message, m.line, m.column);
        } else {
          console.warn('       Warning: %s (%s:%s)', m.message, m.line, m.column);
        }
      });
    }
  });
  // Add any BrowserSync config option here
  eleventyConfig.setBrowserSyncConfig({
    //reloadDelay: 2000,
    files: [ ...componentsFolders ],
    notify: false,
    cors: true,
    middleware: [compress()],
    callbacks: {
      ready: function(err, bs) {
        // store a local reference of BrowserSync object
        browserSync = bs;
      }
    },
    /*
    snippet: false,
    snippetOptions: {
      rule: {
        match: /<head[^>]*>/i,
        fn: function(snippet, match) {
          return match + snippet;
        }
      }
    }*/
  });


  // zUIx.js specific code and life-cycle hooks
  eleventyConfig.addGlobalData("app", zuixConfig.app);
  // Add zUIx transform
  eleventyConfig.addTransform('zuix-js', function(content) {
    const inputPath = this.inputPath;
    const outputPath = this.outputPath;
    const hasChanged = changedFiles.find(f => path.resolve(f) === path.resolve(inputPath));
    if (!rebuildAll && !hasChanged) return content;
    // populates a list of `.html` files
    // to be post processed after build
    if (outputPath && outputPath.endsWith('.html')) {
      let file = path.resolve(outputPath);
      const baseFolder = path.resolve(zuixConfig.build.output);
      if (file.startsWith(baseFolder)) {
        file = file.substring(baseFolder.length + 1);
      }
      postProcessFiles.push({file, baseFolder: zuixConfig.build.output});
    }
    return content;
  });
  eleventyConfig.on('beforeWatch', (cf) => {
    // changedFiles is an array of files that changed
    // to trigger the watch/serve build
    changedFiles.length = 0;
    const baseFolder = path.resolve(zuixConfig.build.input);
    const dataFolder = path.join(baseFolder, zuixConfig.build.dataFolder);
    const includesFolder = path.join(baseFolder, zuixConfig.build.includesFolder);
    const templateChanged = cf.find(f => path.resolve(f).startsWith(includesFolder));
    const dataChanged = cf.find(f => path.resolve(f).startsWith(dataFolder));
    if (templateChanged || dataChanged) {
      rebuildAll = true;
      return;
    }
    console.log(cf);
    changedFiles.push(...cf);
  });
  eleventyConfig.on('afterBuild', async function(args) {
    console.log();
    postProcessFiles.forEach((pf) => {
      const result = zuixCompile(pf.file, pf.file, {
        baseFolder: pf.baseFolder,
        ...zuixConfig
      });
      // TODO: check result code and report
    });
    postProcessFiles.length = 0;
    if (zuixConfig.build.serviceWorker) {
      console.log('\nUpdating Service Worker... ');
      await zuixUtils.generateServiceWorker().then(function () {
        console.log('... Service Worker updated.');
      });
    } else {
      console.log();
    }
    if (rebuildAll) {
      // reverts to incremental build mode
      rebuildAll = false;
    }
  });
  // Watch zuix.js folders (`./templates` and `./source/app`) not watched by 11ty
  eleventyConfig.addWatchTarget('./templates/tags/');
  const watchEvents = {add: true, change: true, unlink: true};
  chokidar.watch(componentsFolders.map(p =>  path.resolve(path.join(sourceFolder, p)))).on('all', (event, file) => {
    if (watchEvents[event] && fs.existsSync(file)) {
      const outputFile = path.resolve(path.join(buildFolder, file.substring(path.resolve(sourceFolder).length)));
      const outputFolder = path.dirname(outputFile);
      if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true })
      }
      fs.copyFileSync(file, outputFile);
    } else {
      // TODO: maybe remove file from output folder as well?
    }
    if (browserSync) {
      browserSync.publicInstance.reload();
    }
  });


  // integrate custom user config with a dedicated
  // `eleventy-config.js` module file
  require('./.eleventy-zuix')(eleventyConfig);


  // Return 11ty configuration options:
  return {
    pathPrefix: zuixConfig.app.baseUrl,
    dir: {
      input: sourceFolder,
      output: buildFolder,
      data: dataFolder,
      includes: includesFolder,
      layouts: "_inc/layouts"
    },
    //htmlTemplateEngine: false, // 'liquid'
    markdownTemplateEngine: 'liquid',
    templateFormats: ['html', 'liquid', 'ejs', 'md', 'hbs', 'mustache', 'haml', 'pug', 'njk', '11ty.js']
  }
};
