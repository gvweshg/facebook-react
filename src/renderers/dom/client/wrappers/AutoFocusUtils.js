/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule AutoFocusUtils
 * @typechecks static-only
 */

'use strict';

var ReactMount = require('ReactMount');

var focusNode = require('focusNode');

var AutoFocusUtils = {
  focusDOMComponent: function() {
    focusNode(ReactMount.getNode(this._rootNodeID));
  },
};

module.exports = AutoFocusUtils;
