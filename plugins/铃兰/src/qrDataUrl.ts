// 轻量 QR Code -> dataURL 生成器，用于网易云扫码登录二维码。
// https://github.com/chillerlan/php-qrcode / https://github.com/kazuhikoarase/qrcode-generator
// 这是 TypeScript 移植版，无外部依赖，仅用于客户端生成登录二维码图片。

const PAD0 = 0xEC;
const PAD1 = 0x11;

const QRMODE_NAME = 'byte';

export function qrTextToDataUrl(text: string, typeNumber = 0, errorCorrectionLevel = 'H'): string {
  const qrcode = createQRCode(typeNumber, errorCorrectionLevel);
  qrcode.addData(text, QRMODE_NAME);
  qrcode.make();
  return qrcode.createDataURL();
}

function createQRCode(typeNumber: number, errorCorrectionLevel: string) {
  const PAD0 = 0xEC;
  const PAD1 = 0x11;

  let _typeNumber = typeNumber;
  let _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
  let _modules: (boolean | null)[][] = [];
  let _moduleCount = 0;
  let _dataCache: number[] | null = null;
  const _dataList: QRData[] = [];

  const _this: any = {};

  const makeImpl = (test: boolean, maskPattern: number) => {
    _moduleCount = _typeNumber * 4 + 17;
    _modules = new Array(_moduleCount);
    for (let row = 0; row < _moduleCount; row += 1) {
      _modules[row] = new Array(_moduleCount);
      for (let col = 0; col < _moduleCount; col += 1) {
        _modules[row][col] = null;
      }
    }
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);

    if (_typeNumber >= 7) {
      setupTypeNumber(test);
    }

    if (_dataCache == null) {
      _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
    }

    mapData(_dataCache, maskPattern);
  };

  const setupPositionProbePattern = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        if (
          (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
          (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
          (2 <= r && r <= 4 && 2 <= c && c <= 4)
        ) {
          _modules[row + r][col + c] = true;
        } else {
          _modules[row + r][col + c] = false;
        }
      }
    }
  };

  const getBestMaskPattern = () => {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i += 1) {
      makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(_this);
      if (i === 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  };

  const setupTimingPattern = () => {
    for (let r = 8; r < _moduleCount - 8; r += 1) {
      if (_modules[r][6] != null) continue;
      _modules[r][6] = r % 2 === 0;
    }
    for (let c = 8; c < _moduleCount - 8; c += 1) {
      if (_modules[6][c] != null) continue;
      _modules[6][c] = c % 2 === 0;
    }
  };

  const setupPositionAdjustPattern = () => {
    const pos = QRUtil.getPatternPosition(_typeNumber);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const row = pos[i];
        const col = pos[j];
        if (_modules[row][col] != null) continue;
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
              _modules[row + r][col + c] = true;
            } else {
              _modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  };

  const setupTypeNumber = (test: boolean) => {
    const bits = QRUtil.getBCHTypeNumber(_typeNumber);
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      _modules[Math.floor(i / 3)][(i % 3) + _moduleCount - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      _modules[(i % 3) + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  };

  const setupTypeInfo = (test: boolean, maskPattern: number) => {
    const data = (_errorCorrectionLevel << 3) | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 6) {
        _modules[i][8] = mod;
      } else if (i < 8) {
        _modules[i + 1][8] = mod;
      } else {
        _modules[_moduleCount - 15 + i][8] = mod;
      }
    }
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && ((bits >> i) & 1) === 1;
      if (i < 8) {
        _modules[8][_moduleCount - i - 1] = mod;
      } else if (i < 9) {
        _modules[8][15 - i - 1 + 1] = mod;
      } else {
        _modules[8][15 - i - 1] = mod;
      }
    }
    _modules[_moduleCount - 8][8] = !test;
  };

  const mapData = (data: number[], maskPattern: number) => {
    let inc = -1;
    let row = _moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = QRUtil.getMaskFunction(maskPattern);
    for (let col = _moduleCount - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          if (_modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
            }
            const mask = maskFunc(row, col - c);
            if (mask) dark = !dark;
            _modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex === -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  };

  const createBytes = (buffer: BitBuffer, rsBlocks: any[]) => {
    let offset = 0;
    let maxDcCount = 0;
    let maxEcCount = 0;
    const dcdata: number[][] = [];
    const ecdata: number[][] = [];
    for (let r = 0; r < rsBlocks.length; r += 1) {
      const dcCount = rsBlocks[r].dataCount;
      const ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dcdata[r] = new Array(dcCount);
      for (let i = 0; i < dcdata[r].length; i += 1) {
        dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
      }
      offset += dcCount;
      const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
      const rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
      const modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (let i = 0; i < ecdata[r].length; i += 1) {
        const modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
      }
    }
    let totalCodeCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalCodeCount += rsBlocks[i].totalCount;
    }
    const data = new Array(totalCodeCount);
    let index = 0;
    for (let i = 0; i < maxDcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < dcdata[r].length) {
          data[index] = dcdata[r][i];
          index += 1;
        }
      }
    }
    for (let i = 0; i < maxEcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < ecdata[r].length) {
          data[index] = ecdata[r][i];
          index += 1;
        }
      }
    }
    return data;
  };

  const createData = (typeNumber: number, errorCorrectionLevel: number, dataList: QRData[]) => {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
    const buffer = new BitBuffer();
    for (let i = 0; i < dataList.length; i += 1) {
      const data = dataList[i];
      buffer.put(data.getMode(), 4);
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
      data.write(buffer);
    }
    const totalDataCount = rsBlocks.reduce((acc, b) => acc + b.dataCount, 0) * 8;
    if (buffer.getLengthInBits() > totalDataCount) {
      throw new Error('code length overflow. (' + buffer.getLengthInBits() + '>' + totalDataCount + ')');
    }
    if (buffer.getLengthInBits() + 4 <= totalDataCount) {
      buffer.put(0, 4);
    }
    while (buffer.getLengthInBits() % 8 !== 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.getLengthInBits() >= totalDataCount) break;
      buffer.put(PAD0, 8);
      if (buffer.getLengthInBits() >= totalDataCount) break;
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  };

  _this.addData = (data: string, mode?: string) => {
    mode = mode || QRMODE_NAME;
    _dataList.push(new QRData(data, mode));
    _dataCache = null;
  };

  _this.isDark = (row: number, col: number) => {
    if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
      throw new Error(row + ',' + col);
    }
    return _modules[row][col];
  };

  _this.getModuleCount = () => _moduleCount;

  _this.make = () => {
    makeImpl(false, getBestMaskPattern());
  };

  _this.createTableTag = (cellSize = 2, margin = 0) => {
    cellSize = cellSize || 2;
    margin = typeof margin === 'undefined' ? cellSize * 4 : margin;
    let qrHtml = '';
    qrHtml += '<table style="border-width:0;border-style:none;border-collapse:collapse;">';
    for (let r = 0; r < _this.getModuleCount(); r += 1) {
      qrHtml += '<tr>';
      for (let c = 0; c < _this.getModuleCount(); c += 1) {
        qrHtml +=
          '<td style="border-width:0;border-style:none;border-collapse:collapse;padding:0;margin:0;width:' +
          cellSize +
          'px;height:' +
          cellSize +
          'px;background-color:' +
          (_this.isDark(r, c) ? '#000' : '#fff') +
          ';"></td>';
      }
      qrHtml += '</tr>';
    }
    qrHtml += '</table>';
    return qrHtml;
  };

  _this.createImgTag = (cellSize = 2, margin = 0) => {
    cellSize = cellSize || 2;
    margin = typeof margin === 'undefined' ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    return createImgTag(size, size, (x: number, y: number) => {
      if (min <= x && x < max && min <= y && y < max) {
        const c = Math.floor((x - min) / cellSize);
        const r = Math.floor((y - min) / cellSize);
        return _this.isDark(r, c) ? 0 : 1;
      }
      return 1;
    });
  };

  _this.createDataURL = (cellSize = 2, margin = 0) => {
    cellSize = cellSize || 2;
    margin = typeof margin === 'undefined' ? cellSize * 4 : margin;
    const moduleCount = _this.getModuleCount();
    const size = moduleCount * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    return createDataURL(size, size, (x: number, y: number) => {
      if (min <= x && x < max && min <= y && y < max) {
        const c = Math.floor((x - min) / cellSize);
        const r = Math.floor((y - min) / cellSize);
        return _this.isDark(r, c) ? 0 : 1;
      }
      return 1;
    });
  };

  return _this;
}

const QRErrorCorrectionLevel: Record<string, number> = { L: 1, M: 0, Q: 3, H: 2 };

const QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7,
};

const QRUtil = {
  PATTERN_POSITION_TABLE: [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]
  ],

  getMaskFunction: (maskPattern: number) => {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000:
        return (i: number, j: number) => (i + j) % 2 === 0;
      case QRMaskPattern.PATTERN001:
        return (i: number, j: number) => i % 2 === 0;
      case QRMaskPattern.PATTERN010:
        return (i: number, j: number) => j % 3 === 0;
      case QRMaskPattern.PATTERN011:
        return (i: number, j: number) => (i + j) % 3 === 0;
      case QRMaskPattern.PATTERN100:
        return (i: number, j: number) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case QRMaskPattern.PATTERN101:
        return (i: number, j: number) => ((i * j) % 2) + ((i * j) % 3) === 0;
      case QRMaskPattern.PATTERN110:
        return (i: number, j: number) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case QRMaskPattern.PATTERN111:
        return (i: number, j: number) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
      default:
        throw new Error('bad maskPattern:' + maskPattern);
    }
  },

  getErrorCorrectPolynomial: (errorCorrectLength: number) => {
    let a = new QRPolynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i += 1) {
      a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
    }
    return a;
  },

  getLengthInBits: (mode: number, type: number) => {
    if (1 <= type && type < 10) {
      switch (mode) {
        case 1: return 10;
        case 2: return 9;
        case 4: return 8;
        case 8: return 8;
        default:
          throw new Error('mode:' + mode);
      }
    } else if (type < 27) {
      switch (mode) {
        case 1: return 12;
        case 2: return 11;
        case 4: return 16;
        case 8: return 10;
        default:
          throw new Error('mode:' + mode);
      }
    } else if (type < 41) {
      switch (mode) {
        case 1: return 14;
        case 2: return 13;
        case 4: return 16;
        case 8: return 12;
        default:
          throw new Error('mode:' + mode);
      }
    }
    throw new Error('type:' + type);
  },

  getLostPoint: (qrCode: any) => {
    const moduleCount = qrCode.getModuleCount();
    let lostPoint = 0;
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        let sameCount = 0;
        const dark = qrCode.isDark(row, col);
        for (let r = -1; r <= 1; r += 1) {
          if (row + r < 0 || moduleCount <= row + r) continue;
          for (let c = -1; c <= 1; c += 1) {
            if (col + c < 0 || moduleCount <= col + c) continue;
            if (r === 0 && c === 0) continue;
            if (dark === qrCode.isDark(row + r, col + c)) {
              sameCount += 1;
            }
          }
        }
        if (sameCount > 5) {
          lostPoint += 3 + sameCount - 5;
        }
      }
    }
    for (let row = 0; row < moduleCount - 1; row += 1) {
      for (let col = 0; col < moduleCount - 1; col += 1) {
        let count = 0;
        if (qrCode.isDark(row, col)) count += 1;
        if (qrCode.isDark(row + 1, col)) count += 1;
        if (qrCode.isDark(row, col + 1)) count += 1;
        if (qrCode.isDark(row + 1, col + 1)) count += 1;
        if (count === 0 || count === 4) {
          lostPoint += 3;
        }
      }
    }
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount - 6; col += 1) {
        if (
          qrCode.isDark(row, col) &&
          !qrCode.isDark(row, col + 1) &&
          qrCode.isDark(row, col + 2) &&
          qrCode.isDark(row, col + 3) &&
          qrCode.isDark(row, col + 4) &&
          !qrCode.isDark(row, col + 5) &&
          qrCode.isDark(row, col + 6)
        ) {
          let r = 0;
          while (col - r >= 0 && qrCode.isDark(row, col - r)) r += 1;
          let c = 0;
          while (col + c < moduleCount && qrCode.isDark(row, col + c)) c += 1;
          if (r + c - 1 >= 4) {
            lostPoint += 40;
          }
        }
      }
    }
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount - 6; row += 1) {
        if (
          qrCode.isDark(row, col) &&
          !qrCode.isDark(row + 1, col) &&
          qrCode.isDark(row + 2, col) &&
          qrCode.isDark(row + 3, col) &&
          qrCode.isDark(row + 4, col) &&
          !qrCode.isDark(row + 5, col) &&
          qrCode.isDark(row + 6, col)
        ) {
          let r = 0;
          while (row - r >= 0 && qrCode.isDark(row - r, col)) r += 1;
          let c = 0;
          while (row + c < moduleCount && qrCode.isDark(row + c, col)) c += 1;
          if (r + c - 1 >= 4) {
            lostPoint += 40;
          }
        }
      }
    }
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount; row += 1) {
        if (qrCode.isDark(row, col)) {
          darkCount += 1;
        }
      }
    }
    const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  },

  getPatternPosition: (typeNumber: number) => {
    return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1];
  },

  getMode: (mode: string): number => {
    if (mode === 'byte' || mode === 'BYTE' || mode === 'Byte') return 4;
    if (mode === 'number' || mode === 'NUMBER' || mode === 'Number') return 1;
    if (mode === 'alpha' || mode === 'ALPHA' || mode === 'Alpha' || mode === 'alphanumeric') return 2;
    if (mode === 'kanji' || mode === 'KANJI' || mode === 'Kanji') return 8;
    return 4; // 默认 byte
  },

  getBCHTypeInfo: (data: number) => {
    let d = data << 10;
    while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRMath.G15) >= 0) {
      d ^= QRMath.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRMath.G15));
    }
    return ((data << 10) | d) ^ QRMath.G15_MASK;
  },

  getBCHTypeNumber: (data: number) => {
    let d = data << 12;
    while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRMath.G18) >= 0) {
      d ^= QRMath.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRMath.G18));
    }
    return (data << 12) | d;
  },

  getBCHDigit: (data: number) => {
    let digit = 0;
    while (data !== 0) {
      digit += 1;
      data >>>= 1;
    }
    return digit;
  },
};

const QRMath: any = {
  glog: (n: number) => {
    if (n < 1) throw new Error('glog(' + n + ')');
    return QRMath.LOG_TABLE[n];
  },
  gexp: (n: number) => {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return QRMath.EXP_TABLE[n];
  },
  EXP_TABLE: new Array(256),
  LOG_TABLE: new Array(256),
};

for (let i = 0; i < 8; i += 1) {
  QRMath.EXP_TABLE[i] = 1 << i;
}
for (let i = 8; i < 256; i += 1) {
  const p =
    QRMath.EXP_TABLE[i - 4] ^
    QRMath.EXP_TABLE[i - 5] ^
    QRMath.EXP_TABLE[i - 6] ^
    QRMath.EXP_TABLE[i - 8];
  QRMath.EXP_TABLE[i] = p;
}
for (let i = 0; i < 255; i += 1) {
  QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;
}

class QRPolynomial {
  num: number[];
  length: number;

  constructor(num: number[], shift: number) {
    if (num.length === undefined) {
      throw new Error(num.length + '/' + shift);
    }
    let offset = 0;
    while (offset < num.length && num[offset] === 0) {
      offset += 1;
    }
    this.num = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i += 1) {
      this.num[i] = num[i + offset];
    }
    this.length = this.num.length;
  }

  getAt(index: number) {
    return this.num[index];
  }

  getLength() {
    return this.length;
  }

  multiply(e: QRPolynomial) {
    const num = new Array(this.getLength() + e.getLength() - 1);
    for (let i = 0; i < this.getLength(); i += 1) {
      for (let j = 0; j < e.getLength(); j += 1) {
        num[i + j] ^= QRMath.gexp(QRMath.glog(this.getAt(i)) + QRMath.glog(e.getAt(j)));
      }
    }
    return new QRPolynomial(num, 0);
  }

  mod(e: QRPolynomial): QRPolynomial {
    if (this.getLength() - e.getLength() < 0) {
      return this;
    }
    const ratio = QRMath.glog(this.getAt(0)) - QRMath.glog(e.getAt(0));
    const num = new Array(this.getLength());
    for (let i = 0; i < this.getLength(); i += 1) {
      num[i] = this.getAt(i);
    }
    for (let i = 0; i < e.getLength(); i += 1) {
      num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
    }
    return new QRPolynomial(num, 0).mod(e);
  }
}

const QRRSBlock = {
  RS_BLOCK_TABLE: [
    [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
    [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
    [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
    [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
    [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
    [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
    [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
    [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
    [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
    [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
    [4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13],
    [2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15],
    [4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12],
    [3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13],
    [5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13],
    [5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16],
    [1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15],
    [5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15],
    [3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14],
    [3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16],
    [4, 144, 116, 4, 145, 117], [17, 68, 42], [17, 50, 22, 6, 51, 23], [19, 46, 16, 6, 47, 17],
    [2, 139, 111, 7, 140, 112], [17, 74, 46], [7, 54, 24, 16, 55, 25], [34, 37, 13],
    [4, 151, 121, 5, 152, 122], [4, 75, 47, 14, 76, 48], [11, 54, 24, 14, 55, 25], [16, 45, 15, 14, 46, 16],
    [6, 147, 117, 4, 148, 118], [6, 73, 45, 14, 74, 46], [11, 54, 24, 16, 55, 25], [30, 46, 16, 2, 47, 17],
    [8, 132, 106, 4, 133, 107], [8, 75, 47, 13, 76, 48], [7, 54, 24, 22, 55, 25], [22, 45, 15, 13, 46, 16],
    [10, 142, 114, 2, 143, 115], [19, 74, 46, 4, 75, 47], [28, 50, 22, 6, 51, 23], [33, 46, 16, 4, 47, 17],
    [8, 152, 122, 4, 153, 123], [22, 73, 45, 3, 74, 46], [8, 53, 23, 26, 54, 24], [12, 45, 15, 28, 46, 16],
    [3, 147, 117, 10, 148, 118], [3, 73, 45, 23, 74, 46], [4, 54, 24, 31, 55, 25], [11, 45, 15, 31, 46, 16],
    [7, 146, 116, 7, 147, 117], [21, 73, 45, 7, 74, 46], [1, 53, 23, 37, 54, 24], [19, 45, 15, 26, 46, 16],
    [5, 145, 115, 10, 146, 116], [19, 75, 47, 10, 76, 48], [15, 54, 24, 25, 55, 25], [23, 45, 15, 25, 46, 16],
    [13, 145, 115, 3, 146, 116], [2, 74, 46, 29, 75, 47], [42, 54, 24, 1, 55, 25], [23, 45, 15, 28, 46, 16],
    [17, 145, 115], [10, 74, 46, 23, 75, 47], [10, 54, 24, 35, 55, 25], [19, 45, 15, 35, 46, 16],
    [17, 145, 115, 1, 146, 116], [14, 74, 46, 21, 75, 47], [29, 54, 24, 19, 55, 25], [11, 45, 15, 46, 46, 16],
    [13, 145, 115, 6, 146, 116], [14, 74, 46, 23, 95, 47], [44, 54, 24, 7, 55, 25], [59, 46, 16, 1, 47, 17],
    [12, 151, 121, 7, 152, 122], [12, 75, 47, 26, 76, 48], [39, 54, 24, 14, 55, 25], [22, 45, 15, 41, 46, 16],
    [6, 151, 121, 14, 152, 122], [6, 75, 47, 34, 76, 48], [46, 54, 24, 10, 55, 25], [2, 45, 15, 64, 46, 16],
    [17, 152, 122, 4, 153, 123], [4, 73, 45, 11, 74, 46], [31, 54, 24, 16, 55, 25], [33, 45, 15, 26, 46, 16],
  ],

  getRSBlocks: (typeNumber: number, errorCorrectionLevel: number) => {
    const rsBlock = QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + errorCorrectionLevel];
    if (rsBlock === undefined) {
      throw new Error('bad rs block @ typeNumber:' + typeNumber + '/errorCorrectionLevel:' + errorCorrectionLevel);
    }
    const length = rsBlock.length / 3;
    const list: { dataCount: number; totalCount: number }[] = [];
    for (let i = 0; i < length; i += 1) {
      const count = rsBlock[i * 3];
      const totalCount = rsBlock[i * 3 + 1];
      const dataCount = rsBlock[i * 3 + 2];
      for (let j = 0; j < count; j += 1) {
        list.push({ dataCount, totalCount });
      }
    }
    return list;
  },
};

// ---------------------------------------------------------------------------
// QRData / BitBuffer / 辅助函数 — 补全 QR Code 内部类型
// ---------------------------------------------------------------------------

class BitBuffer {
  buffer: number[];
  private length: number;

  constructor() {
    this.buffer = new Array(0);
    this.length = 0;
  }

  getBuffer() {
    return this.buffer;
  }

  getLengthInBits() {
    return this.length;
  }

  putBit(bit: boolean) {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) {
      this.buffer.push(0);
    }
    if (bit) {
      this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
    }
    this.length += 1;
  }

  put(num: number, length: number) {
    for (let i = 0; i < length; i += 1) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    }
  }
}

class QRData {
  private mode: number;
  private data: string;

  constructor(data: string, mode?: string) {
    this.mode = QRUtil.getMode(mode || QRMODE_NAME);
    this.data = data;
  }

  getMode() {
    return this.mode;
  }

  getLength() {
    return this.data.length;
  }

  write(buffer: BitBuffer) {
    for (let i = 0; i < this.data.length; i += 1) {
      buffer.put(this.data.charCodeAt(i), 8);
    }
  }
}

// 在 QRMath 上补全 G15 / G18 / G15_MASK 常量
QRMath.G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
QRMath.G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
QRMath.G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);

// createImgTag / createDataURL 辅助函数（生成 PNG dataURL）
function createImgTag(width: number, height: number, getPixel: (x: number, y: number) => number): string {
  const gif = createGIF(width, height, getPixel);
  return 'data:image/gif;base64,' + base64Encode(gif);
}

function createDataURL(width: number, height: number, getPixel: (x: number, y: number) => number): string {
  const gif = createGIF(width, height, getPixel);
  return 'data:image/gif;base64,' + base64Encode(gif);
}

// 生成简单的 GIF 字节流
function createGIF(width: number, height: number, getPixel: (x: number, y: number) => number): number[] {
  const w = width;
  const h = height;
  const ds: number[] = [];
  // GIF Header
  ds.push(0x47, 0x49, 0x46, 0x38, 0x37, 0x61); // GIF87a
  // Logical Screen Descriptor
  ds.push(w & 0xff, (w >> 8) & 0xff);
  ds.push(h & 0xff, (h >> 8) & 0xff);
  ds.push(0x80); // GCT flag = 1, color resolution = 0, sort = 0, GCT size = 0 (2 colors)
  ds.push(0x00); // background color index
  ds.push(0x00); // pixel aspect ratio
  // Global Color Table (2 entries: black, white)
  ds.push(0x00, 0x00, 0x00); // black
  ds.push(0xff, 0xff, 0xff); // white
  // Image Descriptor
  ds.push(0x2c); // image separator
  ds.push(0x00, 0x00, 0x00, 0x00); // left, top
  ds.push(w & 0xff, (w >> 8) & 0xff);
  ds.push(h & 0xff, (h >> 8) & 0xff);
  ds.push(0x00); // no LCT
  // Image Data
  ds.push(0x02); // LZW minimum code size = 2
  const pixels: number[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      pixels.push(getPixel(x, y));
    }
  }
  // LZW encode
  const encoded = lzwEncode(pixels, 2);
  for (let i = 0; i < encoded.length; i += 1) {
    ds.push(encoded[i]);
  }
  ds.push(0x00); // block terminator
  // Trailer
  ds.push(0x3b);
  return ds;
}

// LZW encoding for GIF
function lzwEncode(pixels: number[], minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict: Record<string, number> = {};
  let nextCode = endCode + 1;
  // init dict
  for (let i = 0; i < clearCode; i += 1) {
    dict[String.fromCharCode(i)] = i;
  }
  const output: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const writeCode = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  // flatten into sub-blocks later — for simplicity, output raw
  const blocks: number[] = [];
  const flushBlock = () => {
    if (output.length === 0) return;
    blocks.push(output.length);
    for (let i = 0; i < output.length; i += 1) blocks.push(output[i]);
    output.length = 0;
  };

  writeCode(clearCode);
  let w = '';
  for (let i = 0; i < pixels.length; i += 1) {
    const c = String.fromCharCode(pixels[i]);
    const wc = w + c;
    if (dict[wc] !== undefined) {
      w = wc;
    } else {
      writeCode(dict[w]);
      dict[wc] = nextCode;
      nextCode += 1;
      if (nextCode > (1 << codeSize) && codeSize < 12) {
        codeSize += 1;
      }
      w = c;
    }
  }
  writeCode(dict[w] !== undefined ? dict[w] : 0);
  writeCode(endCode);
  if (bitCount > 0) {
    output.push(bitBuffer & 0xff);
  }
  flushBlock();
  blocks.push(0); // final terminator
  return blocks;
}

// Simple base64 encoder
function base64Encode(bytes: number[]): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] || 0;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    result += chars[(triplet >> 18) & 0x3f];
    result += chars[(triplet >> 12) & 0x3f];
    result += i + 1 < bytes.length ? chars[(triplet >> 6) & 0x3f] : '=';
    result += i + 2 < bytes.length ? chars[triplet & 0x3f] : '=';
    i += 3;
  }
  return result;
}