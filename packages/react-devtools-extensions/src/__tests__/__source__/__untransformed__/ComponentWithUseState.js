/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

const React = require('react');
const {useState} = React;

function Component(props) {
  const [foo] = useState(true);
  const bar = useState(true);
  const [baz] = React.useState(true);
  return `${foo}-${bar}-${baz}`;
}

module.exports = {Component};