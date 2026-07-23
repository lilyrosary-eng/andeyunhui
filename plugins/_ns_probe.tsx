/// <reference path="./global.d.ts" />
// Variant 1: current pattern (expect TS2503 Cannot find namespace 'React')
const React = window.__HOST_REACT__;
const a: React.FC = () => null;

// Variant 2: explicit type annotation (expect still TS2503)
const React2: typeof import('react') = window.__HOST_REACT__;
const b: React2.FC = () => null;

// Variant 3: default import (expect NO TS2503 — this is the intended pattern)
import React3 from 'react';
const c: React3.FC = () => null;

// Variant 4: namespace import (expect NO TS2503)
import * as React4 from 'react';
const d: React4.FC = () => null;

export { a, b, c, d };
