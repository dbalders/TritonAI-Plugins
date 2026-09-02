// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Pipeable.js
var pipeArguments = (self, args2) => {
  switch (args2.length) {
    case 0:
      return self;
    case 1:
      return args2[0](self);
    case 2:
      return args2[1](args2[0](self));
    case 3:
      return args2[2](args2[1](args2[0](self)));
    case 4:
      return args2[3](args2[2](args2[1](args2[0](self))));
    case 5:
      return args2[4](args2[3](args2[2](args2[1](args2[0](self)))));
    case 6:
      return args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self))))));
    case 7:
      return args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self)))))));
    case 8:
      return args2[7](args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self))))))));
    case 9:
      return args2[8](args2[7](args2[6](args2[5](args2[4](args2[3](args2[2](args2[1](args2[0](self)))))))));
    default: {
      let ret = self;
      for (let i = 0, len = args2.length; i < len; i++) {
        ret = args2[i](ret);
      }
      return ret;
    }
  }
};
var Prototype = {
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var Class = /* @__PURE__ */ (function() {
  function PipeableBase() {
  }
  PipeableBase.prototype = Prototype;
  return PipeableBase;
})();

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Function.js
var dual = function(arity, body) {
  if (typeof arity === "function") {
    return function() {
      return arity(arguments) ? body.apply(this, arguments) : (self) => body(self, ...arguments);
    };
  }
  switch (arity) {
    case 0:
    case 1:
      throw new RangeError(`Invalid arity ${arity}`);
    case 2:
      return function(a, b) {
        if (arguments.length >= 2) {
          return body(a, b);
        }
        return function(self) {
          return body(self, a);
        };
      };
    case 3:
      return function(a, b, c) {
        if (arguments.length >= 3) {
          return body(a, b, c);
        }
        return function(self) {
          return body(self, a, b);
        };
      };
    default:
      return function() {
        if (arguments.length >= arity) {
          return body.apply(this, arguments);
        }
        const args2 = arguments;
        return function(self) {
          return body(self, ...args2);
        };
      };
  }
};
var identity = (a) => a;
var constant = (value) => () => value;
var constUndefined = /* @__PURE__ */ constant(void 0);
var constVoid = constUndefined;
function memoize(f) {
  const cache = /* @__PURE__ */ new WeakMap();
  return (a) => {
    if (cache.has(a)) {
      return cache.get(a);
    }
    const result2 = f(a);
    cache.set(a, result2);
    return result2;
  };
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/equal.js
var getAllObjectKeys = (obj) => {
  const keys = new Set(Reflect.ownKeys(obj));
  if (obj.constructor === Object) return keys;
  if (obj instanceof Error) {
    keys.delete("stack");
  }
  const proto = Object.getPrototypeOf(obj);
  let current = proto;
  while (current !== null && current !== Object.prototype) {
    const ownKeys = Reflect.ownKeys(current);
    for (let i = 0; i < ownKeys.length; i++) {
      keys.add(ownKeys[i]);
    }
    current = Object.getPrototypeOf(current);
  }
  if (keys.has("constructor") && typeof obj.constructor === "function" && proto === obj.constructor.prototype) {
    keys.delete("constructor");
  }
  return keys;
};
var byReferenceInstances = /* @__PURE__ */ new WeakSet();

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Predicate.js
function isString(input) {
  return typeof input === "string";
}
function isNumber(input) {
  return typeof input === "number";
}
function isBoolean(input) {
  return typeof input === "boolean";
}
function isSymbol(input) {
  return typeof input === "symbol";
}
function isPropertyKey(u) {
  return isString(u) || isNumber(u) || isSymbol(u);
}
function isFunction(input) {
  return typeof input === "function";
}
function isNotUndefined(input) {
  return input !== void 0;
}
function isNotNullish(input) {
  return input != null;
}
function isNever(_) {
  return false;
}
function isUnknown(_) {
  return true;
}
function isObjectKeyword(input) {
  return typeof input === "object" && input !== null || isFunction(input);
}
var hasProperty = /* @__PURE__ */ dual(2, (self, property) => isObjectKeyword(self) && property in self);

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Hash.js
var symbol = "~effect/interfaces/Hash";
var hash = (self) => {
  switch (typeof self) {
    case "number":
      return number(self);
    case "bigint":
      return string(self.toString(10));
    case "boolean":
      return string(String(self));
    case "symbol":
      return string(String(self));
    case "string":
      return string(self);
    case "undefined":
      return string("undefined");
    case "function":
    case "object": {
      if (self === null) {
        return string("null");
      } else if (self instanceof Date) {
        return string(self.toISOString());
      } else if (self instanceof RegExp) {
        return string(self.toString());
      } else {
        if (byReferenceInstances.has(self)) {
          return random(self);
        }
        if (hashCache.has(self)) {
          return hashCache.get(self);
        }
        const h = withVisitedTracking(self, () => {
          if (isHash(self)) {
            return self[symbol]();
          } else if (typeof self === "function") {
            return random(self);
          } else if (Array.isArray(self) || ArrayBuffer.isView(self)) {
            return array(self);
          } else if (self instanceof Map) {
            return hashMap(self);
          } else if (self instanceof Set) {
            return hashSet(self);
          }
          return structure(self);
        });
        hashCache.set(self, h);
        return h;
      }
    }
    default:
      throw new Error(`BUG: unhandled typeof ${typeof self} - please report an issue at https://github.com/Effect-TS/effect/issues`);
  }
};
var random = (self) => {
  if (!randomHashCache.has(self)) {
    randomHashCache.set(self, number(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)));
  }
  return randomHashCache.get(self);
};
var combine = /* @__PURE__ */ dual(2, (self, b) => self * 53 ^ b);
var optimize = (n) => n & 3221225471 | n >>> 1 & 1073741824;
var isHash = (u) => hasProperty(u, symbol);
var number = (n) => {
  if (n !== n) {
    return string("NaN");
  }
  if (n === Infinity) {
    return string("Infinity");
  }
  if (n === -Infinity) {
    return string("-Infinity");
  }
  let h = n | 0;
  if (h !== n) {
    h ^= n * 4294967295;
  }
  while (n > 4294967295) {
    h ^= n /= 4294967295;
  }
  return optimize(h);
};
var string = (str) => {
  let h = 5381, i = str.length;
  while (i) {
    h = h * 33 ^ str.charCodeAt(--i);
  }
  return optimize(h);
};
var structureKeys = (o, keys) => {
  let h = 12289;
  for (const key of keys) {
    h ^= combine(hash(key), hash(o[key]));
  }
  return optimize(h);
};
var structure = (o) => structureKeys(o, getAllObjectKeys(o));
var iterableWith = (seed, f) => (iter) => {
  let h = seed;
  for (const element of iter) {
    h ^= f(element);
  }
  return optimize(h);
};
var array = /* @__PURE__ */ iterableWith(6151, hash);
var hashMap = /* @__PURE__ */ iterableWith(/* @__PURE__ */ string("Map"), ([k, v]) => combine(hash(k), hash(v)));
var hashSet = /* @__PURE__ */ iterableWith(/* @__PURE__ */ string("Set"), hash);
var randomHashCache = /* @__PURE__ */ new WeakMap();
var hashCache = /* @__PURE__ */ new WeakMap();
var visitedObjects = /* @__PURE__ */ new WeakSet();
function withVisitedTracking(obj, fn2) {
  if (visitedObjects.has(obj)) {
    return string("[Circular]");
  }
  visitedObjects.add(obj);
  const result2 = fn2();
  visitedObjects.delete(obj);
  return result2;
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Equal.js
var symbol2 = "~effect/interfaces/Equal";
function equals() {
  if (arguments.length === 1) {
    return (self) => compareBoth(self, arguments[0]);
  }
  return compareBoth(arguments[0], arguments[1]);
}
function compareBoth(self, that) {
  if (self === that) return true;
  if (self == null || that == null) return false;
  const selfType = typeof self;
  if (selfType !== typeof that) {
    return false;
  }
  if (selfType === "number" && self !== self && that !== that) {
    return true;
  }
  if (selfType !== "object" && selfType !== "function") {
    return false;
  }
  if (byReferenceInstances.has(self) || byReferenceInstances.has(that)) {
    return false;
  }
  return withCache(self, that, compareObjects);
}
function withVisitedTracking2(self, that, fn2) {
  const hasLeft = visitedLeft.has(self);
  const hasRight = visitedRight.has(that);
  if (hasLeft && hasRight) {
    return true;
  }
  if (hasLeft || hasRight) {
    return false;
  }
  visitedLeft.add(self);
  visitedRight.add(that);
  const result2 = fn2();
  visitedLeft.delete(self);
  visitedRight.delete(that);
  return result2;
}
var visitedLeft = /* @__PURE__ */ new WeakSet();
var visitedRight = /* @__PURE__ */ new WeakSet();
function compareObjects(self, that) {
  if (hash(self) !== hash(that)) {
    return false;
  } else if (self instanceof Date) {
    if (!(that instanceof Date)) return false;
    return self.toISOString() === that.toISOString();
  } else if (self instanceof RegExp) {
    if (!(that instanceof RegExp)) return false;
    return self.toString() === that.toString();
  }
  const selfIsEqual = isEqual(self);
  const thatIsEqual = isEqual(that);
  if (selfIsEqual !== thatIsEqual) return false;
  const bothEquals = selfIsEqual && thatIsEqual;
  if (typeof self === "function" && !bothEquals) {
    return false;
  }
  return withVisitedTracking2(self, that, () => {
    if (bothEquals) {
      return self[symbol2](that);
    } else if (Array.isArray(self)) {
      if (!Array.isArray(that) || self.length !== that.length) {
        return false;
      }
      return compareArrays(self, that);
    } else if (ArrayBuffer.isView(self)) {
      if (!ArrayBuffer.isView(that) || self.byteLength !== that.byteLength) {
        return false;
      }
      return compareTypedArrays(self, that);
    } else if (self instanceof Map) {
      if (!(that instanceof Map) || self.size !== that.size) {
        return false;
      }
      return compareMaps(self, that);
    } else if (self instanceof Set) {
      if (!(that instanceof Set) || self.size !== that.size) {
        return false;
      }
      return compareSets(self, that);
    }
    return compareRecords(self, that);
  });
}
function withCache(self, that, f) {
  let selfMap = equalityCache.get(self);
  if (!selfMap) {
    selfMap = /* @__PURE__ */ new WeakMap();
    equalityCache.set(self, selfMap);
  } else if (selfMap.has(that)) {
    return selfMap.get(that);
  }
  const result2 = f(self, that);
  selfMap.set(that, result2);
  let thatMap = equalityCache.get(that);
  if (!thatMap) {
    thatMap = /* @__PURE__ */ new WeakMap();
    equalityCache.set(that, thatMap);
  }
  thatMap.set(self, result2);
  return result2;
}
var equalityCache = /* @__PURE__ */ new WeakMap();
function compareArrays(self, that) {
  for (let i = 0; i < self.length; i++) {
    if (!compareBoth(self[i], that[i])) {
      return false;
    }
  }
  return true;
}
function compareTypedArrays(self, that) {
  if (self.length !== that.length) {
    return false;
  }
  for (let i = 0; i < self.length; i++) {
    if (self[i] !== that[i]) {
      return false;
    }
  }
  return true;
}
function compareRecords(self, that) {
  const selfKeys = getAllObjectKeys(self);
  const thatKeys = getAllObjectKeys(that);
  if (selfKeys.size !== thatKeys.size) {
    return false;
  }
  for (const key of selfKeys) {
    if (!thatKeys.has(key) || !compareBoth(self[key], that[key])) {
      return false;
    }
  }
  return true;
}
function makeCompareMap(keyEquivalence, valueEquivalence) {
  return function compareMaps2(self, that) {
    for (const [selfKey, selfValue] of self) {
      let found = false;
      for (const [thatKey, thatValue] of that) {
        if (keyEquivalence(selfKey, thatKey) && valueEquivalence(selfValue, thatValue)) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  };
}
var compareMaps = /* @__PURE__ */ makeCompareMap(compareBoth, compareBoth);
function makeCompareSet(equivalence) {
  return function compareSets2(self, that) {
    for (const selfValue of self) {
      let found = false;
      for (const thatValue of that) {
        if (equivalence(selfValue, thatValue)) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  };
}
var compareSets = /* @__PURE__ */ makeCompareSet(compareBoth);
var isEqual = (u) => hasProperty(u, symbol2);

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/array.js
var isArrayNonEmpty = (self) => self.length > 0;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/record.js
function assignProperty(self, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(self, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  } else {
    ;
    self[key] = value;
  }
}
function assignProperties(self, source) {
  for (const key of Reflect.ownKeys(source)) {
    if (Object.prototype.propertyIsEnumerable.call(source, key)) {
      assignProperty(self, key, source[key]);
    }
  }
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Redactable.js
var symbolRedactable = /* @__PURE__ */ Symbol.for("~effect/Redactable");
var isRedactable = (u) => hasProperty(u, symbolRedactable);
function redact(u) {
  if (isRedactable(u)) return getRedacted(u);
  return u;
}
function getRedacted(redactable) {
  return redactable[symbolRedactable](globalThis[currentFiberTypeId]?.context ?? emptyContext);
}
var currentFiberTypeId = "~effect/Fiber/currentFiber";
var emptyContext = {
  "~effect/Context": {},
  mapUnsafe: /* @__PURE__ */ new Map(),
  pipe() {
    return pipeArguments(this, arguments);
  }
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Formatter.js
function format(input, options) {
  const space = options?.space ?? 0;
  const seen = /* @__PURE__ */ new WeakSet();
  const gap = !space ? "" : typeof space === "number" ? " ".repeat(space) : space;
  const ind = (d) => gap.repeat(d);
  const wrap = (v, body) => {
    const ctor = v?.constructor;
    return ctor && ctor !== Object.prototype.constructor && ctor.name ? `${ctor.name}(${body})` : body;
  };
  const ownKeys = (o) => {
    try {
      return Reflect.ownKeys(o);
    } catch {
      return ["[ownKeys threw]"];
    }
  };
  function recur2(v, d = 0) {
    if (Array.isArray(v)) {
      if (seen.has(v)) return CIRCULAR;
      seen.add(v);
      if (!gap || v.length <= 1) return `[${v.map((x) => recur2(x, d)).join(",")}]`;
      const inner = v.map((x) => recur2(x, d + 1)).join(",\n" + ind(d + 1));
      return `[
${ind(d + 1)}${inner}
${ind(d)}]`;
    }
    if (v instanceof Date) return formatDate(v);
    if (!options?.ignoreToString && hasProperty(v, "toString") && typeof v["toString"] === "function" && v["toString"] !== Object.prototype.toString && v["toString"] !== Array.prototype.toString) {
      const s = safeToString(v);
      if (v instanceof Error && v.cause) {
        return `${s} (cause: ${recur2(v.cause, d)})`;
      }
      return s;
    }
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || v == null || typeof v === "boolean" || typeof v === "symbol") return String(v);
    if (typeof v === "bigint") return String(v) + "n";
    if (typeof v === "object" || typeof v === "function") {
      if (seen.has(v)) return CIRCULAR;
      seen.add(v);
      if (symbolRedactable in v) return format(getRedacted(v));
      if (Symbol.iterator in v) {
        return `${v.constructor.name}(${recur2(Array.from(v), d)})`;
      }
      const keys = ownKeys(v);
      if (!gap || keys.length <= 1) {
        const body2 = `{${keys.map((k) => `${formatPropertyKey(k)}:${recur2(v[k], d)}`).join(",")}}`;
        return wrap(v, body2);
      }
      const body = `{
${keys.map((k) => `${ind(d + 1)}${formatPropertyKey(k)}: ${recur2(v[k], d + 1)}`).join(",\n")}
${ind(d)}}`;
      return wrap(v, body);
    }
    return String(v);
  }
  return recur2(input, 0);
}
var CIRCULAR = "[Circular]";
function formatPropertyKey(name) {
  return typeof name === "string" ? JSON.stringify(name) : String(name);
}
function formatPath(path) {
  return path.map((key) => `[${formatPropertyKey(key)}]`).join("");
}
function formatDate(date) {
  try {
    return date.toISOString();
  } catch {
    return "Invalid Date";
  }
}
function safeToString(input) {
  try {
    const s = input.toString();
    return typeof s === "string" ? s : String(s);
  } catch {
    return "[toString threw]";
  }
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Inspectable.js
var NodeInspectSymbol = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
var toJson = (input) => {
  try {
    if (hasProperty(input, "toJSON") && isFunction(input["toJSON"]) && input["toJSON"].length === 0) {
      return input.toJSON();
    } else if (Array.isArray(input)) {
      return input.map(toJson);
    }
  } catch {
    return "[toJSON threw]";
  }
  return redact(input);
};
var BaseProto = {
  toJSON() {
    return toJson(this);
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
  toString() {
    return format(this.toJSON());
  }
};
var Class2 = class {
  /**
   * Node.js custom inspection method.
   *
   * **When to use**
   *
   * Use to expose the class JSON representation to Node.js inspection.
   *
   * @since 2.0.0
   */
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  /**
   * Returns a formatted string representation of this object.
   *
   * **When to use**
   *
   * Use to format the class JSON representation as a string.
   *
   * @since 2.0.0
   */
  toString() {
    return format(this.toJSON());
  }
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Utils.js
var SingleShotGen = class _SingleShotGen {
  called = false;
  self;
  constructor(self) {
    this.self = self;
  }
  /**
   * Yields the stored value once, then completes with the value sent back in.
   *
   * **When to use**
   *
   * Use to advance a `SingleShotGen` through its single yield and completion
   * step.
   *
   * @since 2.0.0
   */
  next(a) {
    return this.called ? {
      value: a,
      done: true
    } : (this.called = true, {
      value: this.self,
      done: false
    });
  }
  /**
   * Creates a fresh single-shot iterator over the stored value.
   *
   * **When to use**
   *
   * Use to iterate the wrapped value again without reusing the consumed
   * iterator state.
   *
   * @since 2.0.0
   */
  [Symbol.iterator]() {
    return new _SingleShotGen(this.self);
  }
};
var pickInternalCall = () => {
  const InternalTypeId = "~effect/Utils/internal";
  const standard = {
    [InternalTypeId]: (body) => {
      return body();
    }
  };
  const forced = {
    [InternalTypeId]: (body) => {
      try {
        return body();
      } finally {
      }
    }
  };
  const isNotOptimizedAway = standard[InternalTypeId](() => new Error().stack)?.includes(InternalTypeId) === true;
  return isNotOptimizedAway ? standard[InternalTypeId] : forced[InternalTypeId];
};
var internalCall = /* @__PURE__ */ pickInternalCall();

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/core.js
var EffectTypeId = `~effect/Effect`;
var ExitTypeId = `~effect/Exit`;
var effectVariance = {
  _A: identity,
  _E: identity,
  _R: identity
};
var identifier = `${EffectTypeId}/identifier`;
var args = `${EffectTypeId}/args`;
var evaluate = `${EffectTypeId}/evaluate`;
var contA = `${EffectTypeId}/successCont`;
var contE = `${EffectTypeId}/failureCont`;
var contAll = `${EffectTypeId}/ensureCont`;
var Yield = /* @__PURE__ */ Symbol.for("effect/Effect/Yield");
var PipeInspectableProto = {
  pipe() {
    return pipeArguments(this, arguments);
  },
  toJSON() {
    return {
      ...this
    };
  },
  toString() {
    return format(this.toJSON(), {
      ignoreToString: true,
      space: 2
    });
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
};
var StructuralProto = {
  [symbol]() {
    return structureKeys(this, Object.keys(this));
  },
  [symbol2](that) {
    const selfKeys = Object.keys(this);
    const thatKeys = Object.keys(that);
    if (selfKeys.length !== thatKeys.length) return false;
    for (let i = 0; i < selfKeys.length; i++) {
      if (selfKeys[i] !== thatKeys[i] || !equals(this[selfKeys[i]], that[selfKeys[i]])) {
        return false;
      }
    }
    return true;
  }
};
var EffectProto = {
  [EffectTypeId]: effectVariance,
  ...PipeInspectableProto,
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  },
  toJSON() {
    return {
      _id: "Effect",
      op: this[identifier],
      ...args in this ? {
        args: this[args]
      } : void 0
    };
  }
};
var isExit = (u) => hasProperty(u, ExitTypeId);
var CauseTypeId = "~effect/Cause";
var CauseReasonTypeId = "~effect/Cause/Reason";
var isCause = (self) => hasProperty(self, CauseTypeId);
var CauseImpl = class {
  [CauseTypeId];
  reasons;
  constructor(failures) {
    this[CauseTypeId] = CauseTypeId;
    this.reasons = failures;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toJSON() {
    return {
      _id: "Cause",
      failures: this.reasons.map((f) => f.toJSON())
    };
  }
  toString() {
    return `Cause(${format(this.reasons)})`;
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
  [symbol2](that) {
    return isCause(that) && this.reasons.length === that.reasons.length && this.reasons.every((e, i) => equals(e, that.reasons[i]));
  }
  [symbol]() {
    return array(this.reasons);
  }
};
var annotationsMap = /* @__PURE__ */ new WeakMap();
var ReasonBase = class {
  [CauseReasonTypeId];
  annotations;
  _tag;
  constructor(_tag, annotations, originalError) {
    this[CauseReasonTypeId] = CauseReasonTypeId;
    this._tag = _tag;
    if (annotations !== constEmptyAnnotations && typeof originalError === "object" && originalError !== null && annotations.size > 0) {
      const prevAnnotations = annotationsMap.get(originalError);
      if (prevAnnotations) {
        annotations = new Map([...prevAnnotations, ...annotations]);
      }
      annotationsMap.set(originalError, annotations);
    }
    this.annotations = annotations;
  }
  annotate(annotations, options) {
    if (annotations.mapUnsafe.size === 0) return this;
    const newAnnotations = new Map(this.annotations);
    annotations.mapUnsafe.forEach((value, key) => {
      if (options?.overwrite !== true && newAnnotations.has(key)) return;
      newAnnotations.set(key, value);
    });
    const self = Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    self.annotations = newAnnotations;
    return self;
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  toString() {
    return format(this);
  }
  [NodeInspectSymbol]() {
    return this.toString();
  }
};
var constEmptyAnnotations = /* @__PURE__ */ new Map();
var Fail = class extends ReasonBase {
  error;
  constructor(error, annotations = constEmptyAnnotations) {
    super("Fail", annotations, error);
    this.error = error;
  }
  toString() {
    return `Fail(${format(this.error)})`;
  }
  toJSON() {
    return {
      _tag: "Fail",
      error: this.error
    };
  }
  [symbol2](that) {
    return isFailReason(that) && equals(this.error, that.error) && equals(this.annotations, that.annotations);
  }
  [symbol]() {
    return combine(string(this._tag))(combine(hash(this.error))(hash(this.annotations)));
  }
};
var causeFromReasons = (reasons) => new CauseImpl(reasons);
var causeFail = (error) => new CauseImpl([new Fail(error)]);
var Die = class extends ReasonBase {
  defect;
  constructor(defect, annotations = constEmptyAnnotations) {
    super("Die", annotations, defect);
    this.defect = defect;
  }
  toString() {
    return `Die(${format(this.defect)})`;
  }
  toJSON() {
    return {
      _tag: "Die",
      defect: this.defect
    };
  }
  [symbol2](that) {
    return isDieReason(that) && equals(this.defect, that.defect) && equals(this.annotations, that.annotations);
  }
  [symbol]() {
    return combine(string(this._tag))(combine(hash(this.defect))(hash(this.annotations)));
  }
};
var causeDie = (defect) => new CauseImpl([new Die(defect)]);
var causeAnnotate = /* @__PURE__ */ dual((args2) => isCause(args2[0]), (self, annotations, options) => {
  if (annotations.mapUnsafe.size === 0) return self;
  return new CauseImpl(self.reasons.map((f) => f.annotate(annotations, options)));
});
var isFailReason = (self) => self._tag === "Fail";
var isDieReason = (self) => self._tag === "Die";
var isInterruptReason = (self) => self._tag === "Interrupt";
function defaultEvaluate(_fiber) {
  return exitDie(`Effect.evaluate: Not implemented`);
}
var makePrimitiveProto = (options) => ({
  ...EffectProto,
  [identifier]: options.op,
  [evaluate]: options[evaluate] ?? defaultEvaluate,
  [contA]: options[contA],
  [contE]: options[contE],
  [contAll]: options[contAll]
});
var makePrimitive = (options) => {
  const Proto2 = makePrimitiveProto(options);
  return function() {
    const self = Object.create(Proto2);
    self[args] = options.single === false ? arguments : arguments[0];
    return self;
  };
};
var makeExit = (options) => {
  const Proto2 = {
    ...makePrimitiveProto(options),
    [ExitTypeId]: ExitTypeId,
    _tag: options.op,
    get [options.prop]() {
      return this[args];
    },
    toString() {
      return `${options.op}(${format(this[args])})`;
    },
    toJSON() {
      return {
        _id: "Exit",
        _tag: options.op,
        [options.prop]: this[args]
      };
    },
    [symbol2](that) {
      return isExit(that) && that._tag === this._tag && equals(this[args], that[args]);
    },
    [symbol]() {
      return combine(string(options.op), hash(this[args]));
    }
  };
  return function(value) {
    const self = Object.create(Proto2);
    self[args] = value;
    return self;
  };
};
var exitSucceed = /* @__PURE__ */ makeExit({
  op: "Success",
  prop: "value",
  [evaluate](fiber2) {
    const cont = fiber2.getCont(contA);
    return cont ? cont[contA](this[args], fiber2, this) : fiber2.yieldWith(this);
  }
});
var StackTraceKey = {
  key: "effect/Cause/StackTrace"
};
var InterruptorStackTrace = {
  key: "effect/Cause/InterruptorStackTrace"
};
var exitFailCause = /* @__PURE__ */ makeExit({
  op: "Failure",
  prop: "cause",
  [evaluate](fiber2) {
    let cause = this[args];
    let annotated = false;
    if (fiber2.currentStackFrame) {
      cause = causeAnnotate(cause, {
        mapUnsafe: /* @__PURE__ */ new Map([[StackTraceKey.key, fiber2.currentStackFrame]])
      });
      annotated = true;
    }
    let cont = fiber2.getCont(contE);
    while (fiber2.interruptible && fiber2._interruptedCause && cont) {
      cont = fiber2.getCont(contE);
    }
    return cont ? cont[contE](cause, fiber2, annotated ? void 0 : this) : fiber2.yieldWith(annotated ? exitFailCause(cause) : this);
  }
});
var exitFail = (e) => exitFailCause(causeFail(e));
var exitDie = (defect) => exitFailCause(causeDie(defect));
var withFiber = /* @__PURE__ */ makePrimitive({
  op: "WithFiber",
  [evaluate](fiber2) {
    return this[args](fiber2);
  }
});
var YieldableError = /* @__PURE__ */ (function() {
  class YieldableError2 extends globalThis.Error {
  }
  const proto = /* @__PURE__ */ makePrimitiveProto({
    op: "YieldableError",
    [evaluate]() {
      return exitFail(this);
    }
  });
  delete proto.toString;
  Object.assign(YieldableError2.prototype, proto);
  return YieldableError2;
})();
var Error2 = /* @__PURE__ */ (function() {
  const plainArgsSymbol = /* @__PURE__ */ Symbol.for("effect/Data/Error/plainArgs");
  return class Base extends YieldableError {
    constructor(args2) {
      super(args2?.message, args2?.cause ? {
        cause: args2.cause
      } : void 0);
      if (args2) {
        assignProperties(this, args2);
        Object.defineProperty(this, plainArgsSymbol, {
          value: args2,
          enumerable: false
        });
      }
    }
    toJSON() {
      return {
        ...this[plainArgsSymbol],
        ...this
      };
    }
  };
})();
var TaggedError = (tag2) => {
  class Base3 extends Error2 {
    _tag = tag2;
  }
  ;
  Base3.prototype.name = tag2;
  return Base3;
};
var NoSuchElementErrorTypeId = "~effect/Cause/NoSuchElementError";
var NoSuchElementError = class extends (/* @__PURE__ */ TaggedError("NoSuchElementError")) {
  [NoSuchElementErrorTypeId] = NoSuchElementErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var DoneTypeId = "~effect/Cause/Done";
var DoneVoid = {
  [DoneTypeId]: DoneTypeId,
  _tag: "Done",
  value: void 0
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/option.js
var TypeId = "~effect/data/Option";
var CommonProto = {
  [TypeId]: {
    _A: (_) => _
  },
  ...PipeInspectableProto,
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  }
};
var SomeProto = /* @__PURE__ */ Object.defineProperty(/* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto), {
  _tag: "Some",
  _op: "Some",
  [symbol2](that) {
    return isOption(that) && isSome(that) && equals(this.value, that.value);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.value));
  },
  toString() {
    return `some(${format(this.value)})`;
  },
  toJSON() {
    return {
      _id: "Option",
      _tag: this._tag,
      value: toJson(this.value)
    };
  }
}), "valueOrUndefined", {
  get() {
    return this.value;
  }
});
var NoneHash = /* @__PURE__ */ hash("None");
var NoneProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto), {
  _tag: "None",
  _op: "None",
  valueOrUndefined: void 0,
  [symbol2](that) {
    return isOption(that) && isNone(that);
  },
  [symbol]() {
    return NoneHash;
  },
  toString() {
    return `none()`;
  },
  toJSON() {
    return {
      _id: "Option",
      _tag: this._tag
    };
  }
});
var isOption = (input) => hasProperty(input, TypeId);
var isNone = (fa) => fa._tag === "None";
var isSome = (fa) => fa._tag === "Some";
var none = /* @__PURE__ */ Object.create(NoneProto);
var some = (value) => {
  const a = Object.create(SomeProto);
  a.value = value;
  return a;
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/result.js
var TypeId2 = "~effect/data/Result";
var CommonProto2 = {
  [TypeId2]: {
    /* v8 ignore next 2 */
    _A: (_) => _,
    _E: (_) => _
  },
  ...PipeInspectableProto,
  [Symbol.iterator]() {
    return new SingleShotGen(this);
  }
};
var SuccessProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto2), {
  _tag: "Success",
  _op: "Success",
  [symbol2](that) {
    return isResult(that) && isSuccess(that) && equals(this.success, that.success);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.success));
  },
  toString() {
    return `success(${format(this.success)})`;
  },
  toJSON() {
    return {
      _id: "Result",
      _tag: this._tag,
      value: toJson(this.success)
    };
  }
});
var FailureProto = /* @__PURE__ */ Object.assign(/* @__PURE__ */ Object.create(CommonProto2), {
  _tag: "Failure",
  _op: "Failure",
  [symbol2](that) {
    return isResult(that) && isFailure(that) && equals(this.failure, that.failure);
  },
  [symbol]() {
    return combine(hash(this._tag))(hash(this.failure));
  },
  toString() {
    return `failure(${format(this.failure)})`;
  },
  toJSON() {
    return {
      _id: "Result",
      _tag: this._tag,
      failure: toJson(this.failure)
    };
  }
});
var isResult = (input) => hasProperty(input, TypeId2);
var isFailure = (result2) => result2._tag === "Failure";
var isSuccess = (result2) => result2._tag === "Success";
var fail = (failure) => {
  const a = Object.create(FailureProto);
  a.failure = failure;
  return a;
};
var succeed = (success) => {
  const a = Object.create(SuccessProto);
  a.success = success;
  return a;
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Order.js
function make(compare) {
  return (self, that) => self === that ? 0 : compare(self, that);
}
var Number2 = /* @__PURE__ */ make((self, that) => {
  if (globalThis.Number.isNaN(self) && globalThis.Number.isNaN(that)) return 0;
  if (globalThis.Number.isNaN(self)) return -1;
  if (globalThis.Number.isNaN(that)) return 1;
  return self < that ? -1 : 1;
});
var isLessThan = (O) => dual(2, (self, that) => O(self, that) === -1);
var isGreaterThan = (O) => dual(2, (self, that) => O(self, that) === 1);
var isLessThanOrEqualTo = (O) => dual(2, (self, that) => O(self, that) !== 1);
var isGreaterThanOrEqualTo = (O) => dual(2, (self, that) => O(self, that) !== -1);

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Option.js
var none2 = () => none;
var some2 = some;
var isNone2 = isNone;
var isSome2 = isSome;
var map = /* @__PURE__ */ dual(2, (self, f) => isNone2(self) ? none2() : some2(f(self.value)));
var filter = /* @__PURE__ */ dual(2, (self, predicate) => isNone2(self) ? none2() : predicate(self.value) ? some2(self.value) : none2());

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Result.js
var succeed2 = succeed;
var fail2 = fail;
var isFailure2 = isFailure;
var match = /* @__PURE__ */ dual(2, (self, {
  onFailure,
  onSuccess
}) => isFailure2(self) ? onFailure(self.failure) : onSuccess(self.success));

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Array.js
var Array2 = globalThis.Array;
var fromIterable = (collection) => Array2.isArray(collection) ? collection : Array2.from(collection);
var append = /* @__PURE__ */ dual(2, (self, last) => [...self, last]);
var appendAll = /* @__PURE__ */ dual(2, (self, that) => fromIterable(self).concat(fromIterable(that)));
var isArray = Array2.isArray;
var isArrayNonEmpty2 = isArrayNonEmpty;
var isReadonlyArrayNonEmpty = isArrayNonEmpty;
var hashBucketsAdd = (buckets, value) => {
  const hash2 = hash(value);
  const bucket = buckets.get(hash2);
  if (bucket === void 0) {
    buckets.set(hash2, [value]);
    return true;
  }
  for (const previous of bucket) {
    if (equals(previous, value)) {
      return false;
    }
  }
  bucket.push(value);
  return true;
};
var union = /* @__PURE__ */ dual(2, (self, that) => {
  const a = fromIterable(self);
  const b = fromIterable(that);
  if (isReadonlyArrayNonEmpty(a)) {
    return isReadonlyArrayNonEmpty(b) ? dedupe(appendAll(a, b)) : a;
  }
  return b;
});
var empty = () => [];
var map2 = /* @__PURE__ */ dual(2, (self, f) => self.map(f));
var dedupe = (self) => {
  const input = fromIterable(self);
  if (input.length < 2) {
    return [...input];
  }
  const buckets = /* @__PURE__ */ new Map();
  const out = [];
  for (const value of input) {
    if (hashBucketsAdd(buckets, value)) {
      out.push(value);
    }
  }
  return out;
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Effectable.js
var Prototype2 = (options) => makePrimitiveProto({
  op: options.label,
  [evaluate]: options.evaluate
});

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/stackTraceLimit.js
var isStackTraceLimitWritable = () => {
  const desc = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  if (desc === void 0) {
    return Object.isExtensible(Error);
  }
  return Object.hasOwn(desc, "writable") ? desc.writable === true : desc.set !== void 0;
};
var canWriteStackTraceLimit = /* @__PURE__ */ isStackTraceLimitWritable();
var getStackTraceLimit = () => Error.stackTraceLimit;
var setStackTraceLimit = (value) => {
  if (canWriteStackTraceLimit) {
    ;
    Error.stackTraceLimit = value;
  }
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Context.js
var ServiceTypeId = "~effect/Context/Service";
var Service = function() {
  const prevLimit = getStackTraceLimit();
  setStackTraceLimit(2);
  const err = new Error();
  setStackTraceLimit(prevLimit);
  function KeyClass() {
  }
  const self = KeyClass;
  Object.setPrototypeOf(self, ServiceProto);
  Object.defineProperty(self, "stack", {
    get() {
      return err.stack;
    }
  });
  if (arguments.length > 0) {
    self.key = arguments[0];
    if (arguments[1]?.defaultValue) {
      self[ReferenceTypeId] = ReferenceTypeId;
      self.defaultValue = arguments[1].defaultValue;
    }
    return self;
  }
  return function(key, options) {
    self.key = key;
    if (options?.make) {
      ;
      self.make = options.make;
    }
    return self;
  };
};
var ServiceProto = {
  [ServiceTypeId]: ServiceTypeId,
  .../* @__PURE__ */ Prototype2({
    label: "Service",
    evaluate(fiber2) {
      return exitSucceed(get(fiber2.context, this));
    }
  }),
  toJSON() {
    return {
      _id: "Service",
      key: this.key,
      stack: this.stack
    };
  },
  of(self) {
    return self;
  },
  context(self) {
    return make2(this, self);
  },
  use(f) {
    return withFiber((fiber2) => f(get(fiber2.context, this)));
  },
  useSync(f) {
    return withFiber((fiber2) => exitSucceed(f(get(fiber2.context, this))));
  }
};
var ReferenceTypeId = "~effect/Context/Reference";
var TypeId3 = "~effect/Context";
var makeUnsafe = (mapUnsafe) => {
  const self = Object.create(Proto);
  self.mapUnsafe = mapUnsafe;
  self.mutable = false;
  return self;
};
var Proto = {
  ...PipeInspectableProto,
  [TypeId3]: {
    _Services: (_) => _
  },
  toJSON() {
    return {
      _id: "Context",
      services: Array.from(this.mapUnsafe).map(([key, value]) => ({
        key,
        value
      }))
    };
  },
  [symbol2](that) {
    if (!isContext(that) || this.mapUnsafe.size !== that.mapUnsafe.size) return false;
    for (const k of this.mapUnsafe.keys()) {
      if (!that.mapUnsafe.has(k) || !equals(this.mapUnsafe.get(k), that.mapUnsafe.get(k))) {
        return false;
      }
    }
    return true;
  },
  [symbol]() {
    return number(this.mapUnsafe.size);
  }
};
var isContext = (u) => hasProperty(u, TypeId3);
var empty2 = () => emptyContext2;
var emptyContext2 = /* @__PURE__ */ makeUnsafe(/* @__PURE__ */ new Map());
var make2 = (key, service2) => makeUnsafe(/* @__PURE__ */ new Map([[key.key, service2]]));
var add = /* @__PURE__ */ dual(3, (self, key, service2) => withMapUnsafe(self, (map7) => {
  map7.set(key.key, service2);
}));
var getUnsafe = /* @__PURE__ */ dual(2, (self, service2) => {
  if (!self.mapUnsafe.has(service2.key)) {
    if (ReferenceTypeId in service2) return getDefaultValue(service2);
    throw serviceNotFoundError(service2);
  }
  return self.mapUnsafe.get(service2.key);
});
var get = getUnsafe;
var getReferenceUnsafe = (self, service2) => {
  if (!self.mapUnsafe.has(service2.key)) {
    return getDefaultValue(service2);
  }
  return self.mapUnsafe.get(service2.key);
};
var defaultValueCacheKey = "~effect/Context/defaultValue";
var getDefaultValue = (ref) => {
  if (defaultValueCacheKey in ref) {
    return ref[defaultValueCacheKey];
  }
  return ref[defaultValueCacheKey] = ref.defaultValue();
};
var serviceNotFoundError = (service2) => {
  const error = new Error(`Service not found${service2.key ? `: ${String(service2.key)}` : ""}`);
  if (service2.stack) {
    const lines = service2.stack.split("\n");
    if (lines.length > 2) {
      const afterAt = lines[2].match(/at (.*)/);
      if (afterAt) {
        error.message = error.message + ` (defined at ${afterAt[1]})`;
      }
    }
  }
  if (error.stack) {
    const lines = error.stack.split("\n");
    lines.splice(1, 3);
    error.stack = lines.join("\n");
  }
  return error;
};
var withMapUnsafe = (self, f) => {
  if (self.mutable) {
    f(self.mapUnsafe);
    return self;
  }
  const map7 = new Map(self.mapUnsafe);
  f(map7);
  return makeUnsafe(map7);
};
var Reference = Service;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Scheduler.js
var Scheduler = /* @__PURE__ */ Reference("effect/Scheduler", {
  defaultValue: () => new MixedScheduler()
});
var setImmediate = "setImmediate" in globalThis ? (f) => {
  const timer = globalThis.setImmediate(f);
  return () => globalThis.clearImmediate(timer);
} : (f) => {
  const timer = setTimeout(f, 0);
  return () => clearTimeout(timer);
};
var PriorityBuckets = class {
  buckets = [];
  scheduleTask(task, priority) {
    const buckets = this.buckets;
    const len = buckets.length;
    let bucket;
    let index = 0;
    for (; index < len; index++) {
      if (buckets[index][0] > priority) break;
      bucket = buckets[index];
    }
    if (bucket && bucket[0] === priority) {
      bucket[1].push(task);
    } else if (index === len) {
      buckets.push([priority, [task]]);
    } else {
      buckets.splice(index, 0, [priority, [task]]);
    }
  }
  drain() {
    const buckets = this.buckets;
    this.buckets = [];
    return buckets;
  }
};
var MixedScheduler = class {
  executionMode;
  setImmediate;
  constructor(executionMode = "async", setImmediateFn = setImmediate) {
    this.executionMode = executionMode;
    this.setImmediate = setImmediateFn;
  }
  /**
   * Returns whether the fiber has reached its operation budget and should yield.
   *
   * **When to use**
   *
   * Use to decide whether a fiber should yield after consuming its current
   * operation budget.
   *
   * @since 2.0.0
   */
  shouldYield(fiber2) {
    return fiber2.currentOpCount >= fiber2.maxOpsBeforeYield;
  }
  /**
   * Creates a dispatcher that schedules work through this scheduler.
   *
   * **When to use**
   *
   * Use when you need a standalone dispatcher from a scheduler instance, for
   * example in tests that enqueue tasks and then flush them deterministically.
   *
   * @since 4.0.0
   */
  makeDispatcher() {
    return new MixedSchedulerDispatcher(this.setImmediate);
  }
};
var MixedSchedulerDispatcher = class {
  tasks = /* @__PURE__ */ new PriorityBuckets();
  running = void 0;
  setImmediate;
  constructor(setImmediateFn = setImmediate) {
    this.setImmediate = setImmediateFn;
  }
  /**
   * @since 2.0.0
   */
  scheduleTask(task, priority) {
    this.tasks.scheduleTask(task, priority);
    if (this.running === void 0) {
      this.running = this.setImmediate(this.afterScheduled);
    }
  }
  /**
   * @since 2.0.0
   */
  afterScheduled = () => {
    this.running = void 0;
    this.runTasks();
  };
  /**
   * @since 2.0.0
   */
  runTasks() {
    const buckets = this.tasks.drain();
    for (let i = 0; i < buckets.length; i++) {
      const toRun = buckets[i][1];
      for (let j = 0; j < toRun.length; j++) {
        toRun[j]();
      }
    }
  }
  /**
   * @since 2.0.0
   */
  flush() {
    while (this.tasks.buckets.length > 0) {
      if (this.running !== void 0) {
        this.running();
        this.running = void 0;
      }
      this.runTasks();
    }
  }
};
var MaxOpsBeforeYield = /* @__PURE__ */ Reference("effect/Scheduler/MaxOpsBeforeYield", {
  defaultValue: () => 2048
});
var PreventSchedulerYield = /* @__PURE__ */ Reference("effect/Scheduler/PreventSchedulerYield", {
  defaultValue: () => false
});

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Tracer.js
var ParentSpanKey = "effect/Tracer/ParentSpan";
var TracerKey = "effect/Tracer";

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/metric.js
var FiberRuntimeMetricsKey = "effect/observability/Metric/FiberRuntimeMetricsKey";

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/references.js
var CurrentStackFrame = /* @__PURE__ */ Reference("effect/References/CurrentStackFrame", {
  defaultValue: constUndefined
});
var CurrentLogLevel = /* @__PURE__ */ Reference("effect/References/CurrentLogLevel", {
  defaultValue: () => "Info"
});
var MinimumLogLevel = /* @__PURE__ */ Reference("effect/References/MinimumLogLevel", {
  defaultValue: () => "Info"
});

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/version.js
var version = "dev";

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/effect.js
var Interrupt = class extends ReasonBase {
  fiberId;
  constructor(fiberId2, annotations = constEmptyAnnotations) {
    super("Interrupt", annotations, "Interrupted");
    this.fiberId = fiberId2;
  }
  toString() {
    return `Interrupt(${this.fiberId})`;
  }
  toJSON() {
    return {
      _tag: "Interrupt",
      fiberId: this.fiberId
    };
  }
  [symbol2](that) {
    return isInterruptReason(that) && this.fiberId === that.fiberId && this.annotations === that.annotations;
  }
  [symbol]() {
    return combine(string(`${this._tag}:${this.fiberId}`))(random(this.annotations));
  }
};
var causeInterrupt = (fiberId2) => new CauseImpl([new Interrupt(fiberId2)]);
var findError = (self) => {
  for (let i = 0; i < self.reasons.length; i++) {
    const reason = self.reasons[i];
    if (reason._tag === "Fail") {
      return succeed2(reason.error);
    }
  }
  return fail2(self);
};
var hasInterrupts = (self) => self.reasons.some(isInterruptReason);
var causeCombine = /* @__PURE__ */ dual(2, (self, that) => {
  if (self.reasons.length === 0) {
    return that;
  } else if (that.reasons.length === 0) {
    return self;
  }
  const newCause = new CauseImpl(union(self.reasons, that.reasons));
  return equals(self, newCause) ? self : newCause;
});
var causeMap = /* @__PURE__ */ dual(2, (self, f) => {
  let hasFail = false;
  const failures = self.reasons.map((failure) => {
    if (isFailReason(failure)) {
      hasFail = true;
      return new Fail(f(failure.error));
    }
    return failure;
  });
  return hasFail ? causeFromReasons(failures) : self;
});
var FiberTypeId = `~effect/Fiber/${version}`;
var fiberVariance = {
  _A: identity,
  _E: identity
};
var fiberIdStore = {
  id: 0
};
var getCurrentFiber = () => globalThis[currentFiberTypeId];
var FiberImpl = class {
  constructor(context2, interruptible2 = true) {
    this[FiberTypeId] = fiberVariance;
    this.setContext(context2);
    this.id = ++fiberIdStore.id;
    this.currentOpCount = 0;
    this.interruptible = interruptible2;
    this._stack = [];
    this._observers = [];
    this._exit = void 0;
    this._children = void 0;
    this._interruptedCause = void 0;
    this._yielded = void 0;
    this._running = false;
    this._deferredInterrupt = false;
    this.runtimeMetrics?.recordFiberStart(this.context);
  }
  [FiberTypeId];
  id;
  interruptible;
  currentOpCount;
  _stack;
  _observers;
  _exit;
  _children;
  _interruptedCause;
  _yielded;
  _running;
  _deferredInterrupt;
  // set in setContext
  context;
  currentScheduler;
  currentTracerContext;
  currentSpan;
  currentLogLevel;
  minimumLogLevel;
  currentStackFrame;
  runtimeMetrics;
  maxOpsBeforeYield;
  currentPreventYield;
  _dispatcher = void 0;
  get currentDispatcher() {
    return this._dispatcher ??= this.currentScheduler.makeDispatcher();
  }
  getRef(ref) {
    return getReferenceUnsafe(this.context, ref);
  }
  addObserver(cb) {
    if (this._exit) {
      cb(this._exit);
      return constVoid;
    }
    this._observers.push(cb);
    return () => {
      const index = this._observers.indexOf(cb);
      if (index >= 0) {
        this._observers.splice(index, 1);
      }
    };
  }
  interruptUnsafe(fiberId2, annotations) {
    if (this._exit) {
      return;
    }
    let cause = causeInterrupt(fiberId2);
    if (this.currentStackFrame) {
      cause = causeAnnotate(cause, make2(StackTraceKey, this.currentStackFrame));
    }
    if (annotations) {
      cause = causeAnnotate(cause, annotations);
    }
    this._interruptedCause = this._interruptedCause ? causeCombine(this._interruptedCause, cause) : cause;
    if (this.interruptible) {
      if (this._running) {
        this._deferredInterrupt = true;
      } else {
        this.evaluate(failCause(this._interruptedCause));
      }
    }
  }
  pollUnsafe() {
    return this._exit;
  }
  evaluate(effect) {
    if (this._exit) {
      return;
    } else if (this._yielded !== void 0) {
      const yielded = this._yielded;
      this._yielded = void 0;
      yielded();
    }
    const exit3 = this.runLoop(effect);
    if (exit3 === Yield) {
      return;
    }
    const interruptChildren = fiberMiddleware.interruptChildren && fiberMiddleware.interruptChildren(this);
    if (interruptChildren !== void 0) {
      return this.evaluate(flatMap(interruptChildren, () => exit3));
    }
    this._exit = exit3;
    this.runtimeMetrics?.recordFiberEnd(this.context, this._exit);
    for (let i = 0; i < this._observers.length; i++) {
      this._observers[i](exit3);
    }
    this._observers.length = 0;
    this._stack.length = 0;
    this._children = void 0;
    this.context = empty2();
  }
  runLoop(effect) {
    const prevFiber = globalThis[currentFiberTypeId];
    globalThis[currentFiberTypeId] = this;
    const prevRunning = this._running;
    this._running = true;
    let yielding = false;
    let current = effect;
    this.currentOpCount = 0;
    try {
      while (true) {
        if (this._deferredInterrupt) {
          this._deferredInterrupt = false;
          current = failCause(this._interruptedCause);
        }
        this.currentOpCount++;
        if (!yielding && !this.currentPreventYield && this.currentScheduler.shouldYield(this)) {
          yielding = true;
          const prev = current;
          current = flatMap(yieldNow, () => prev);
        }
        current = this.currentTracerContext ? this.currentTracerContext(current, this) : current[evaluate](this);
        if (current === Yield) {
          const yielded = this._yielded;
          if (ExitTypeId in yielded) {
            this._deferredInterrupt = false;
            this._yielded = void 0;
            return yielded;
          } else if (this._deferredInterrupt) {
            this._yielded = void 0;
            yielded();
            continue;
          }
          return Yield;
        }
      }
    } catch (error) {
      if (!hasProperty(current, evaluate)) {
        return exitDie(`Fiber.runLoop: Not a valid effect: ${String(current)}`);
      }
      return this.runLoop(exitDie(error));
    } finally {
      this._running = prevRunning;
      globalThis[currentFiberTypeId] = prevFiber;
    }
  }
  getCont(symbol4) {
    if (this._deferredInterrupt) {
      this._deferredInterrupt = false;
      return deferredInterruptCont;
    }
    while (true) {
      const op = this._stack.pop();
      if (!op) return void 0;
      const cont = op[contAll] && op[contAll](this);
      if (cont) {
        ;
        cont[symbol4] = cont;
        return cont;
      }
      if (op[symbol4]) return op;
    }
  }
  yieldWith(value) {
    this._yielded = value;
    return Yield;
  }
  children() {
    return this._children ??= /* @__PURE__ */ new Set();
  }
  pipe() {
    return pipeArguments(this, arguments);
  }
  setContext(context2) {
    this.context = context2;
    const scheduler = this.getRef(Scheduler);
    if (scheduler !== this.currentScheduler) {
      this.currentScheduler = scheduler;
      this._dispatcher = void 0;
    }
    this.currentSpan = context2.mapUnsafe.get(ParentSpanKey);
    this.currentLogLevel = this.getRef(CurrentLogLevel);
    this.minimumLogLevel = this.getRef(MinimumLogLevel);
    this.currentStackFrame = context2.mapUnsafe.get(CurrentStackFrame.key);
    this.maxOpsBeforeYield = this.getRef(MaxOpsBeforeYield);
    this.currentPreventYield = this.getRef(PreventSchedulerYield);
    this.runtimeMetrics = context2.mapUnsafe.get(FiberRuntimeMetricsKey);
    const currentTracer = context2.mapUnsafe.get(TracerKey);
    this.currentTracerContext = currentTracer ? currentTracer["context"] : void 0;
  }
  get currentSpanLocal() {
    return this.currentSpan?._tag === "Span" ? this.currentSpan : void 0;
  }
};
var deferredInterruptCont = {
  [contA](_value, fiber2) {
    return failCause(fiber2._interruptedCause);
  },
  [contE](_cause, fiber2) {
    return failCause(fiber2._interruptedCause);
  }
};
var fiberMiddleware = {
  interruptChildren: void 0
};
var fiberStackAnnotations = (fiber2) => {
  if (!fiber2.currentStackFrame) return void 0;
  const annotations = /* @__PURE__ */ new Map();
  annotations.set(InterruptorStackTrace.key, fiber2.currentStackFrame);
  return makeUnsafe(annotations);
};
var fiberAwaitAll = (self) => callback((resume) => {
  const iter = self[Symbol.iterator]();
  const exits = [];
  let cancel = void 0;
  function loop() {
    let result2 = iter.next();
    while (!result2.done) {
      if (result2.value._exit) {
        exits.push(result2.value._exit);
        result2 = iter.next();
        continue;
      }
      cancel = result2.value.addObserver((exit3) => {
        exits.push(exit3);
        loop();
      });
      return;
    }
    resume(succeed3(exits));
  }
  loop();
  return sync(() => cancel?.());
});
var fiberInterruptAll = (fibers) => withFiber((parent) => {
  const annotations = fiberStackAnnotations(parent);
  let fiberArr = empty();
  for (const fiber2 of fibers) {
    fiber2.interruptUnsafe(parent.id, annotations);
    fiberArr.push(fiber2);
  }
  return asVoid(fiberAwaitAll(fiberArr));
});
var succeed3 = exitSucceed;
var failCause = exitFailCause;
var fail3 = exitFail;
var sync = /* @__PURE__ */ makePrimitive({
  op: "Sync",
  [evaluate](fiber2) {
    const value = this[args]();
    const cont = fiber2.getCont(contA);
    return cont ? cont[contA](value, fiber2) : fiber2.yieldWith(exitSucceed(value));
  }
});
var suspend = /* @__PURE__ */ makePrimitive({
  op: "Suspend",
  [evaluate](_fiber) {
    return this[args]();
  }
});
var fromResult = /* @__PURE__ */ match({
  onFailure: fail3,
  onSuccess: succeed3
});
var yieldNowWith = /* @__PURE__ */ makePrimitive({
  op: "Yield",
  [evaluate](fiber2) {
    let resumed = false;
    fiber2.currentDispatcher.scheduleTask(() => {
      if (resumed) return;
      fiber2.evaluate(exitVoid);
    }, this[args] ?? 0);
    return fiber2.yieldWith(() => {
      resumed = true;
    });
  }
});
var yieldNow = /* @__PURE__ */ yieldNowWith(0);
var succeedSome = (a) => succeed3(some2(a));
var succeedNone = /* @__PURE__ */ succeed3(/* @__PURE__ */ none2());
var failCauseSync = (evaluate2) => suspend(() => failCause(internalCall(evaluate2)));
var die = (defect) => exitDie(defect);
var failSync = (error) => suspend(() => fail3(internalCall(error)));
var void_ = /* @__PURE__ */ succeed3(void 0);
var try_ = (options) => {
  const evaluate2 = typeof options === "function" ? options : options.try;
  const catcher = typeof options === "function" ? (cause) => new UnknownError(cause, "An error occurred in Effect.try") : options.catch;
  return suspend(() => {
    try {
      return succeed3(internalCall(evaluate2));
    } catch (err) {
      return fail3(internalCall(() => catcher(err)));
    }
  });
};
var tryPromise = (options) => {
  const f = typeof options === "function" ? options : options.try;
  const catcher = typeof options === "function" ? (cause) => new UnknownError(cause, "An error occurred in Effect.tryPromise") : options.catch;
  return callbackOptions(function(resume, signal) {
    const failWithCatch = (cause) => {
      try {
        resume(fail3(internalCall(() => catcher(cause))));
      } catch (err) {
        resume(die(err));
      }
    };
    try {
      internalCall(() => f(signal)).then((a) => resume(succeed3(a)), failWithCatch);
    } catch (err) {
      failWithCatch(err);
    }
  }, f.length !== 0);
};
var callbackOptions = /* @__PURE__ */ makePrimitive({
  op: "Async",
  single: false,
  [evaluate](fiber2) {
    const register = internalCall(() => this[args][0].bind(fiber2.currentScheduler));
    let resumed = false;
    let yielded = false;
    const controller = this[args][1] ? new AbortController() : void 0;
    const onCancel = register((effect) => {
      if (resumed) return;
      resumed = true;
      if (yielded) {
        fiber2.evaluate(effect);
      } else {
        yielded = effect;
      }
    }, controller?.signal);
    if (yielded !== false) return yielded;
    yielded = true;
    fiber2._yielded = () => {
      resumed = true;
    };
    if (controller === void 0 && onCancel === void 0) {
      return Yield;
    }
    fiber2._stack.push(asyncFinalizer(() => {
      resumed = true;
      controller?.abort();
      return onCancel ?? exitVoid;
    }));
    return Yield;
  }
});
var asyncFinalizer = /* @__PURE__ */ makePrimitive({
  op: "AsyncFinalizer",
  [contAll](fiber2) {
    if (fiber2.interruptible) {
      fiber2.interruptible = false;
      fiber2._stack.push(setInterruptibleTrue);
    }
  },
  [contE](cause, _fiber) {
    return hasInterrupts(cause) ? flatMap(this[args](), () => failCause(cause)) : failCause(cause);
  }
});
var callback = (register) => callbackOptions(register, register.length >= 2);
var defineFunctionLength = (length, fn2) => Object.defineProperty(fn2, "length", {
  value: length,
  configurable: true
});
var fnUntracedEager = (body, ...pipeables) => defineFunctionLength(body.length, pipeables.length === 0 ? function() {
  return fromIteratorEagerUnsafe(() => body.apply(this, arguments));
} : function() {
  let effect = fromIteratorEagerUnsafe(() => body.apply(this, arguments));
  for (const pipeable of pipeables) {
    effect = pipeable(effect);
  }
  return effect;
});
var fromIteratorEagerUnsafe = (evaluate2) => {
  try {
    const iterator = evaluate2();
    let value = void 0;
    while (true) {
      const state = iterator.next(value);
      if (state.done) {
        return succeed3(state.value);
      }
      const primitive = state.value;
      if (primitive && primitive._tag === "Success") {
        value = primitive.value;
        continue;
      } else if (primitive && primitive._tag === "Failure") {
        return state.value;
      } else {
        let isFirstExecution = true;
        return suspend(() => {
          if (isFirstExecution) {
            isFirstExecution = false;
            return flatMap(state.value, (value2) => fromIteratorUnsafe(iterator, value2));
          } else {
            return suspend(() => fromIteratorUnsafe(evaluate2()));
          }
        });
      }
    }
  } catch (error) {
    return die(error);
  }
};
var fromIteratorUnsafe = /* @__PURE__ */ makePrimitive({
  op: "Iterator",
  single: false,
  [contA](value, fiber2) {
    const iter = this[args][0];
    while (true) {
      const state = iter.next(value);
      if (state.done) return succeed3(state.value);
      if (!effectIsExit(state.value)) {
        fiber2._stack.push(this);
        return state.value;
      } else if (state.value._tag === "Failure") {
        return state.value;
      }
      value = state.value.value;
    }
  },
  [evaluate](fiber2) {
    return this[contA](this[args][1], fiber2);
  }
});
var asVoid = (self) => flatMap(self, (_) => exitVoid);
var flatMap = /* @__PURE__ */ dual(2, (self, f) => {
  const onSuccess = Object.create(OnSuccessProto);
  onSuccess[args] = self;
  onSuccess[contA] = f.length !== 1 ? (a) => f(a) : f;
  return onSuccess;
});
var OnSuccessProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnSuccess",
  [evaluate](fiber2) {
    fiber2._stack.push(this);
    return this[args];
  }
});
var effectIsExit = (effect) => ExitTypeId in effect;
var flatMapEager = /* @__PURE__ */ dual(2, (self, f) => {
  if (effectIsExit(self)) {
    return self._tag === "Success" ? f(self.value) : self;
  }
  return flatMap(self, f);
});
var map3 = /* @__PURE__ */ dual(2, (self, f) => flatMap(self, (a) => succeed3(internalCall(() => f(a)))));
var mapEager = /* @__PURE__ */ dual(2, (self, f) => effectIsExit(self) ? exitMap(self, f) : map3(self, f));
var mapErrorEager = /* @__PURE__ */ dual(2, (self, f) => effectIsExit(self) ? exitMapError(self, f) : mapError(self, f));
var exitIsSuccess = (self) => self._tag === "Success";
var exitVoid = /* @__PURE__ */ exitSucceed(void 0);
var exitMap = /* @__PURE__ */ dual(2, (self, f) => self._tag === "Success" ? exitSucceed(f(self.value)) : self);
var exitMapError = /* @__PURE__ */ dual(2, (self, f) => {
  if (self._tag === "Success") return self;
  const error = findError(self.cause);
  if (isFailure2(error)) return self;
  return exitFail(f(error.success));
});
var catchCause = /* @__PURE__ */ dual(2, (self, f) => {
  const onFailure = Object.create(OnFailureProto);
  onFailure[args] = self;
  onFailure[contE] = f.length !== 1 ? (cause) => f(cause) : f;
  return onFailure;
});
var OnFailureProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnFailure",
  [evaluate](fiber2) {
    fiber2._stack.push(this);
    return this[args];
  }
});
var catchCauseFilter = /* @__PURE__ */ dual(3, (self, filter3, f) => catchCause(self, (cause) => {
  const eb = filter3(cause);
  return isFailure2(eb) ? failCause(eb.failure) : internalCall(() => f(eb.success, cause));
}));
var catch_ = /* @__PURE__ */ dual(2, (self, f) => catchCauseFilter(self, findError, (e) => f(e)));
var mapError = /* @__PURE__ */ dual(2, (self, f) => catch_(self, (error) => failSync(() => f(error))));
var OnSuccessAndFailureProto = /* @__PURE__ */ makePrimitiveProto({
  op: "OnSuccessAndFailure",
  [evaluate](fiber2) {
    fiber2._stack.push(this);
    return this[args];
  }
});
var exit = (self) => effectIsExit(self) ? exitSucceed(self) : exitPrimitive(self);
var exitPrimitive = /* @__PURE__ */ makePrimitive({
  op: "Exit",
  [evaluate](fiber2) {
    fiber2._stack.push(this);
    return this[args];
  },
  [contA](value, _, exit3) {
    return succeed3(exit3 ?? exitSucceed(value));
  },
  [contE](cause, _, exit3) {
    return succeed3(exit3 ?? exitFailCause(cause));
  }
});
var onExitPrimitive = /* @__PURE__ */ makePrimitive({
  op: "OnExit",
  single: false,
  [evaluate](fiber2) {
    fiber2._stack.push(this);
    return this[args][0];
  },
  [contAll](fiber2) {
    if (fiber2.interruptible && this[args][2] !== true) {
      fiber2._stack.push(setInterruptibleTrue);
      fiber2.interruptible = false;
    }
  },
  [contA](value, _, exit3) {
    exit3 ??= exitSucceed(value);
    const eff = this[args][1](exit3);
    return eff ? flatMap(eff, (_2) => exit3) : exit3;
  },
  [contE](cause, _, exit3) {
    exit3 ??= exitFailCause(cause);
    const eff = this[args][1](exit3);
    return eff ? flatMap(eff, (_2) => exit3) : exit3;
  }
});
var uninterruptible = (self) => withFiber((fiber2) => {
  if (!fiber2.interruptible) return self;
  fiber2.interruptible = false;
  fiber2._stack.push(setInterruptibleTrue);
  return self;
});
var setInterruptible = /* @__PURE__ */ makePrimitive({
  op: "SetInterruptible",
  [contAll](fiber2) {
    fiber2.interruptible = this[args];
    if (fiber2._interruptedCause && fiber2.interruptible) {
      return () => failCause(fiber2._interruptedCause);
    }
  }
});
var setInterruptibleTrue = /* @__PURE__ */ setInterruptible(true);
var whileLoop = /* @__PURE__ */ makePrimitive({
  op: "While",
  [contA](value, fiber2) {
    this[args].step(value);
    if (this[args].while()) {
      fiber2._stack.push(this);
      return this[args].body();
    }
    return exitVoid;
  },
  [evaluate](fiber2) {
    if (this[args].while()) {
      fiber2._stack.push(this);
      return this[args].body();
    }
    return exitVoid;
  }
});
var iterateEagerImpl = (options) => {
  const onItem = options.onItem;
  const step = options.step;
  return (state, items, opts) => {
    let index = opts?.start ?? 0;
    const end = opts?.end ?? items.length;
    const concurrency = opts?.concurrency ?? 1;
    const orderedStep = opts?.orderedStep === true && concurrency > 1;
    let done2 = false;
    let parentFiber;
    let fibers;
    let resume;
    let interrupted = false;
    let terminal;
    let effect;
    let nextIndex = index;
    const exits = orderedStep ? new Array(end) : void 0;
    const failDefect = (error) => {
      const defect = exitDie(error);
      terminal = defect;
      done2 = true;
      interrupted = true;
      return fibers && fibers.size > 0 ? flatMap(uninterruptible(fiberInterruptAll(Array.from(fibers))), () => defect) : defect;
    };
    const runStep = (item, exit3, currentIndex) => {
      if (!orderedStep) return step(state, item, exit3, currentIndex);
      if (terminal) return terminal;
      exits[currentIndex] = exit3;
      while (nextIndex < end) {
        const nextExit = exits[nextIndex];
        if (nextExit === void 0) return;
        exits[nextIndex] = void 0;
        const index2 = nextIndex++;
        const result2 = step(state, items[index2], nextExit, index2);
        if (result2) return result2;
      }
    };
    const go = () => {
      let paused = false;
      for (; !terminal && index < end; index++) {
        const item = items[index];
        const eff = effect ?? onItem(state, item, index);
        if (effectIsExit(eff)) {
          terminal = runStep(item, eff, index);
          if (terminal) break;
        } else if (concurrency === 1) {
          return flatMap(exit(eff), (exit3) => {
            terminal = runStep(item, exit3, index);
            index++;
            return terminal ?? go() ?? void_;
          });
        } else if (!parentFiber) {
          return callback((cb) => {
            parentFiber = getCurrentFiber();
            fibers = /* @__PURE__ */ new Set();
            effect = eff;
            resume = cb;
            let result2;
            try {
              result2 = go();
            } catch (error) {
              return cb(failDefect(error));
            }
            if (result2) return cb(result2);
            return suspend(() => {
              terminal = exitVoid;
              interrupted = true;
              return fibers ? fiberInterruptAll(fibers) : void_;
            });
          });
        } else {
          effect = void 0;
          const fiber2 = forkUnsafe(parentFiber, eff, true, true, "inherit");
          if (fiber2._exit) {
            terminal = runStep(item, fiber2._exit, index);
            if (terminal) break;
            continue;
          }
          fibers.add(fiber2);
          const currentIndex = index;
          fiber2.addObserver((exit3) => {
            fibers.delete(fiber2);
            try {
              if (terminal) {
                if (!interrupted && exit3._tag === "Failure") {
                  for (const reason of exit3.cause.reasons) {
                    if (reason._tag === "Interrupt") continue;
                    else if (terminal._tag === "Failure") {
                      ;
                      terminal.cause.reasons.push(reason);
                    } else {
                      terminal = exitFailCause(causeFromReasons([reason]));
                    }
                  }
                }
              } else {
                const result2 = runStep(item, exit3, currentIndex);
                if (result2) {
                  terminal = result2._tag === "Failure" ? exitFailCause(causeFromReasons(result2.cause.reasons.slice())) : result2;
                  go();
                }
              }
              if (paused) {
                const eff2 = go();
                if (eff2) resume(eff2);
              } else if (done2 && fibers.size === 0) {
                resume(terminal ?? void_);
              }
            } catch (error) {
              resume(failDefect(error));
            }
          });
          if (fibers.size < concurrency) continue;
          paused = true;
          index++;
          return;
        }
      }
      done2 = true;
      if (terminal) {
        if (fibers && fibers.size > 0) {
          const annotations = fiberStackAnnotations(parentFiber);
          fibers.forEach((f) => f.interruptUnsafe(parentFiber.id, annotations));
          return;
        }
        if (resume || terminal._tag === "Failure") {
          return terminal;
        }
      } else if (resume) {
        if (!fibers) {
          return exitVoid;
        } else if (fibers.size === 0) {
          resume(void_);
        }
      }
    };
    return go();
  };
};
var iterateEager = () => iterateEagerImpl;
var forkUnsafe = (parent, effect, immediate = false, daemon = false, uninterruptible2 = false) => {
  const interruptible2 = uninterruptible2 === "inherit" ? parent.interruptible : !uninterruptible2;
  const child = new FiberImpl(parent.context, interruptible2);
  if (immediate) {
    child.evaluate(effect);
  } else {
    parent.currentDispatcher.scheduleTask(() => child.evaluate(effect), 0);
  }
  if (!daemon && !child._exit) {
    parent.children().add(child);
    child.addObserver(() => parent._children.delete(child));
  }
  return child;
};
var runForkWith = (context2) => (effect, options) => {
  const fiber2 = new FiberImpl(options?.scheduler ? add(context2, Scheduler, options.scheduler) : context2, options?.uninterruptible !== true);
  fiber2.evaluate(effect);
  if (fiber2._exit) return fiber2;
  if (options?.signal) {
    if (options.signal.aborted) {
      fiber2.interruptUnsafe();
    } else {
      const abort = () => fiber2.interruptUnsafe();
      options.signal.addEventListener("abort", abort, {
        once: true
      });
      fiber2.addObserver(() => options.signal.removeEventListener("abort", abort));
    }
  }
  if (options?.onFiberStart) {
    options.onFiberStart(fiber2);
  }
  return fiber2;
};
var runPromiseExitWith = (context2) => {
  const runFork3 = runForkWith(context2);
  return (effect, options) => {
    const fiber2 = runFork3(effect, options);
    return new Promise((resolve2) => {
      fiber2.addObserver((exit3) => resolve2(exit3));
    });
  };
};
var runPromiseExit = /* @__PURE__ */ runPromiseExitWith(/* @__PURE__ */ empty2());
var runSyncExitWith = (context2) => {
  const runFork3 = runForkWith(context2);
  return (effect) => {
    if (effectIsExit(effect)) return effect;
    const scheduler = new MixedScheduler("sync");
    const fiber2 = runFork3(effect, {
      scheduler
    });
    fiber2._dispatcher?.flush();
    return fiber2._exit ?? exitDie(new AsyncFiberError(fiber2));
  };
};
var runSyncExit = /* @__PURE__ */ runSyncExitWith(/* @__PURE__ */ empty2());
var MAX_TIMER_MILLIS = 2 ** 31 - 1;
var TimeoutErrorTypeId = "~effect/Cause/TimeoutError";
var TimeoutError = class extends (/* @__PURE__ */ TaggedError("TimeoutError")) {
  [TimeoutErrorTypeId] = TimeoutErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var IllegalArgumentErrorTypeId = "~effect/Cause/IllegalArgumentError";
var IllegalArgumentError = class extends (/* @__PURE__ */ TaggedError("IllegalArgumentError")) {
  [IllegalArgumentErrorTypeId] = IllegalArgumentErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var ExceededCapacityErrorTypeId = "~effect/Cause/ExceededCapacityError";
var ExceededCapacityError = class extends (/* @__PURE__ */ TaggedError("ExceededCapacityError")) {
  [ExceededCapacityErrorTypeId] = ExceededCapacityErrorTypeId;
  constructor(message) {
    super({
      message
    });
  }
};
var AsyncFiberErrorTypeId = "~effect/Cause/AsyncFiberError";
var AsyncFiberError = class extends (/* @__PURE__ */ TaggedError("AsyncFiberError")) {
  [AsyncFiberErrorTypeId] = AsyncFiberErrorTypeId;
  constructor(fiber2) {
    super({
      message: "An asynchronous Effect was executed with Effect.runSync",
      fiber: fiber2
    });
  }
};
var UnknownErrorTypeId = "~effect/Cause/UnknownError";
var UnknownError = class extends (/* @__PURE__ */ TaggedError("UnknownError")) {
  [UnknownErrorTypeId] = UnknownErrorTypeId;
  constructor(cause, message) {
    super({
      message,
      cause
    });
  }
};
var LoggerTypeId = "~effect/Logger";
var LoggerProto = {
  [LoggerTypeId]: {
    _Message: identity,
    _Output: identity
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var colors = {
  bold: "1",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  cyan: "36",
  white: "37",
  gray: "90",
  black: "30",
  bgBrightRed: "101"
};
var logLevelColors = {
  None: [],
  All: [],
  Trace: [colors.gray],
  Debug: [colors.blue],
  Info: [colors.green],
  Warn: [colors.yellow],
  Error: [colors.red],
  Fatal: [colors.bgBrightRed, colors.black]
};

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Cause.js
var isFailReason2 = isFailReason;
var map4 = causeMap;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Data.js
var TaggedError2 = TaggedError;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Exit.js
var failCause2 = exitFailCause;
var fail4 = exitFail;
var void_2 = exitVoid;
var isSuccess3 = exitIsSuccess;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Effect.js
var tryPromise2 = tryPromise;
var succeed4 = succeed3;
var succeedNone2 = succeedNone;
var succeedSome2 = succeedSome;
var fail5 = fail3;
var failCauseSync2 = failCauseSync;
var try_2 = try_;
var fromResult2 = fromResult;
var flatMap2 = flatMap;
var exit2 = exit;
var catchCause2 = catchCause;
var runPromiseExit2 = runPromiseExit;
var runSyncExit2 = runSyncExit;
var mapEager2 = mapEager;
var mapErrorEager2 = mapErrorEager;
var flatMapEager2 = flatMapEager;
var fnUntracedEager2 = fnUntracedEager;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Encoding.js
var EncodingErrorTypeId = "~effect/encoding/EncodingError";
var EncodingError = class extends (/* @__PURE__ */ TaggedError2("EncodingError")) {
  /**
   * Marks this value as an encoding or decoding error for runtime guards.
   *
   * **When to use**
   *
   * Use to identify `EncodingError` instances through `isEncodingError`.
   *
   * @since 4.0.0
   */
  [EncodingErrorTypeId] = EncodingErrorTypeId;
};
var encodeBase64 = (input) => typeof input === "string" ? base64EncodeUint8Array(encoder.encode(input)) : base64EncodeUint8Array(input);
var decodeBase64 = (str) => {
  const stripped = stripCrlf(str);
  const length = stripped.length;
  if (length % 4 !== 0) {
    return fail2(new EncodingError({
      kind: "Decode",
      module: "Base64",
      input: stripped,
      message: `Length must be a multiple of 4, but is ${length}`
    }));
  }
  const index = stripped.indexOf("=");
  if (index !== -1 && (index < length - 2 || index === length - 2 && stripped[length - 1] !== "=")) {
    return fail2(new EncodingError({
      kind: "Decode",
      module: "Base64",
      input: stripped,
      message: `Found a '=' character, but it is not at the end`
    }));
  }
  try {
    const missingOctets = stripped.endsWith("==") ? 2 : stripped.endsWith("=") ? 1 : 0;
    const result2 = new Uint8Array(3 * (length / 4) - missingOctets);
    for (let i = 0, j = 0; i < length; i += 4, j += 3) {
      const buffer = getBase64Code(stripped.charCodeAt(i)) << 18 | getBase64Code(stripped.charCodeAt(i + 1)) << 12 | getBase64Code(stripped.charCodeAt(i + 2)) << 6 | getBase64Code(stripped.charCodeAt(i + 3));
      result2[j] = buffer >> 16;
      result2[j + 1] = buffer >> 8 & 255;
      result2[j + 2] = buffer & 255;
    }
    return succeed2(result2);
  } catch (e) {
    return fail2(new EncodingError({
      kind: "Decode",
      module: "Base64",
      input: stripped,
      message: e instanceof Error ? e.message : "Invalid input"
    }));
  }
};
var encoder = /* @__PURE__ */ new TextEncoder();
var stripCrlf = (str) => str.replace(/[\n\r]/g, "");
var base64EncodeUint8Array = (bytes) => {
  const length = bytes.length;
  let result2 = "";
  let i;
  for (i = 2; i < length; i += 3) {
    result2 += base64abc[bytes[i - 2] >> 2];
    result2 += base64abc[(bytes[i - 2] & 3) << 4 | bytes[i - 1] >> 4];
    result2 += base64abc[(bytes[i - 1] & 15) << 2 | bytes[i] >> 6];
    result2 += base64abc[bytes[i] & 63];
  }
  if (i === length + 1) {
    result2 += base64abc[bytes[i - 2] >> 2];
    result2 += base64abc[(bytes[i - 2] & 3) << 4];
    result2 += "==";
  }
  if (i === length) {
    result2 += base64abc[bytes[i - 2] >> 2];
    result2 += base64abc[(bytes[i - 2] & 3) << 4 | bytes[i - 1] >> 4];
    result2 += base64abc[(bytes[i - 1] & 15) << 2];
    result2 += "=";
  }
  return result2;
};
function getBase64Code(charCode) {
  if (charCode >= base64codes.length) {
    throw new TypeError(`Invalid character ${String.fromCharCode(charCode)}`);
  }
  const code = base64codes[charCode];
  if (code === 255) {
    throw new TypeError(`Invalid character ${String.fromCharCode(charCode)}`);
  }
  return code;
}
var base64abc = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "/"];
var base64codes = [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 62, 255, 255, 255, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 255, 255, 255, 0, 255, 255, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 255, 255, 255, 255, 255, 255, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51];

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/schema/annotations.js
function resolve(ast) {
  return ast.checks ? ast.checks[ast.checks.length - 1].annotations : ast.annotations;
}
function resolveAt(key) {
  return (ast) => resolve(ast)?.[key];
}
var STRUCTURAL_ANNOTATION_KEY = "~structural";
var IDENTIFIER_FALLBACK_KEY = "~identifier";
var SENTINELS_ANNOTATION_KEY = "~sentinels";
var jsonSchemaAnnotationKeys = ["title", "description", "default", "examples", "readOnly", "writeOnly", "format", "contentEncoding", "contentMediaType", "contentSchema"];
var resolveIdentifier = /* @__PURE__ */ resolveAt("identifier");
var resolveIdentifierFallback = /* @__PURE__ */ resolveAt(IDENTIFIER_FALLBACK_KEY);
var getExpected = /* @__PURE__ */ memoize((ast) => {
  const identifier2 = resolveIdentifier(ast);
  if (typeof identifier2 === "string") return identifier2;
  return ast.getExpected(getExpected);
});
var annotationExcludedKeys = /* @__PURE__ */ new Set([SENTINELS_ANNOTATION_KEY, STRUCTURAL_ANNOTATION_KEY, "representation", "arbitrary", "brands", "toJsonSchema", "toCode", "toArbitrary", "toEquivalence", "toFormatter", "toCodec", "toCodecJson", "toCodecStringTree", "toCodecIso"]);

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/SchemaIssue.js
var TypeId4 = "~effect/SchemaIssue/Issue";
function isIssue(u) {
  return hasProperty(u, TypeId4) && u[TypeId4] === TypeId4;
}
var Base = class {
  [TypeId4] = TypeId4;
  toString() {
    return defaultFormatter(this);
  }
};
var Filter = class extends Base {
  _tag = "Filter";
  /**
   * The input value that caused the issue.
   */
  actual;
  /**
   * The filter that failed.
   */
  filter;
  /**
   * The issue that occurred.
   */
  issue;
  constructor(actual, filter3, issue) {
    super();
    this.actual = actual;
    this.filter = filter3;
    this.issue = issue;
  }
};
var Encoding = class extends Base {
  _tag = "Encoding";
  /**
   * The schema that caused the issue.
   */
  ast;
  /**
   * The input value that caused the issue.
   */
  actual;
  /**
   * The issue that occurred.
   */
  issue;
  constructor(ast, actual, issue) {
    super();
    this.ast = ast;
    this.actual = actual;
    this.issue = issue;
  }
};
var Pointer = class extends Base {
  _tag = "Pointer";
  /**
   * The path to the location in the input that caused the issue.
   */
  path;
  /**
   * The issue that occurred.
   */
  issue;
  constructor(path, issue) {
    super();
    this.path = path;
    this.issue = issue;
  }
};
var MissingKey = class extends Base {
  _tag = "MissingKey";
  /**
   * The metadata for the issue.
   */
  annotations;
  constructor(annotations) {
    super();
    this.annotations = annotations;
  }
};
var UnexpectedKey = class extends Base {
  _tag = "UnexpectedKey";
  /**
   * The schema that caused the issue.
   */
  ast;
  /**
   * The input value that caused the issue.
   */
  actual;
  constructor(ast, actual) {
    super();
    this.ast = ast;
    this.actual = actual;
  }
};
var Composite = class extends Base {
  _tag = "Composite";
  /**
   * The schema that caused the issue.
   */
  ast;
  /**
   * The input value that caused the issue.
   */
  actual;
  /**
   * The issues that occurred.
   */
  issues;
  constructor(ast, actual, issues) {
    super();
    this.ast = ast;
    this.actual = actual;
    this.issues = issues;
  }
};
var InvalidType = class extends Base {
  _tag = "InvalidType";
  /**
   * The schema that caused the issue.
   */
  ast;
  /**
   * The input value that caused the issue.
   */
  actual;
  constructor(ast, actual) {
    super();
    this.ast = ast;
    this.actual = actual;
  }
};
var InvalidValue = class extends Base {
  _tag = "InvalidValue";
  /**
   * The value that caused the issue.
   */
  actual;
  /**
   * The metadata for the issue.
   */
  annotations;
  constructor(actual, annotations) {
    super();
    this.actual = actual;
    this.annotations = annotations;
  }
};
var AnyOf = class extends Base {
  _tag = "AnyOf";
  /**
   * The schema that caused the issue.
   */
  ast;
  /**
   * The input value that caused the issue.
   */
  actual;
  /**
   * The issues that occurred.
   */
  issues;
  constructor(ast, actual, issues) {
    super();
    this.ast = ast;
    this.actual = actual;
    this.issues = issues;
  }
};
var OneOf = class extends Base {
  _tag = "OneOf";
  /**
   * The schema that caused the issue.
   */
  ast;
  /**
   * The input value that caused the issue.
   */
  actual;
  /**
   * The schemas that were successful.
   */
  successes;
  constructor(ast, actual, successes) {
    super();
    this.ast = ast;
    this.actual = actual;
    this.successes = successes;
  }
};
function makeFilterIssue(input, entry) {
  if (isIssue(entry)) {
    return entry;
  }
  if (typeof entry === "string") {
    return new InvalidValue(some2(input), {
      message: entry
    });
  }
  const inner = typeof entry.issue === "string" ? new InvalidValue(some2(input), {
    message: entry.issue
  }) : entry.issue;
  return new Pointer(entry.path, inner);
}
function makeSingle(input, out) {
  if (out === void 0) {
    return void 0;
  }
  if (typeof out === "boolean") {
    return out ? void 0 : new InvalidValue(some2(input));
  }
  return makeFilterIssue(input, out);
}
function make3(input, ast, out) {
  if (Array.isArray(out)) {
    if (isReadonlyArrayNonEmpty(out)) {
      if (out.length === 1) {
        return makeFilterIssue(input, out[0]);
      }
      return new Composite(ast, some2(input), map2(out, (entry) => makeFilterIssue(input, entry)));
    }
    return void 0;
  }
  return makeSingle(input, out);
}
var defaultLeafHook = (issue) => {
  const message = findMessage(issue);
  if (message !== void 0) return message;
  switch (issue._tag) {
    case "InvalidType":
      return getExpectedMessage(getExpected(issue.ast), formatOption(issue.actual));
    case "InvalidValue":
      return `Invalid data ${formatOption(issue.actual)}`;
    case "MissingKey":
      return "Missing key";
    case "UnexpectedKey":
      return `Unexpected key with value ${format(issue.actual)}`;
    case "Forbidden":
      return "Forbidden operation";
    case "OneOf":
      return `Expected exactly one member to match the input ${format(issue.actual)}`;
  }
};
var defaultCheckHook = (issue) => {
  return findMessage(issue.issue) ?? findMessage(issue);
};
function getExpectedMessage(expected, actual) {
  return `Expected ${expected}, got ${actual}`;
}
function toDefaultIssues(issue, path, leafHook, checkHook) {
  switch (issue._tag) {
    case "Filter": {
      const message = checkHook(issue);
      if (message !== void 0) {
        return [{
          path,
          message
        }];
      }
      switch (issue.issue._tag) {
        case "InvalidValue":
          return [{
            path,
            message: getExpectedMessage(formatCheck(issue.filter), format(issue.actual))
          }];
        default:
          return toDefaultIssues(issue.issue, path, leafHook, checkHook);
      }
    }
    case "Encoding":
      return toDefaultIssues(issue.issue, path, leafHook, checkHook);
    case "Pointer":
      return toDefaultIssues(issue.issue, [...path, ...issue.path], leafHook, checkHook);
    case "Composite":
      return issue.issues.flatMap((issue2) => toDefaultIssues(issue2, path, leafHook, checkHook));
    case "AnyOf": {
      const message = findMessage(issue);
      if (issue.issues.length === 0) {
        if (message !== void 0) return [{
          path,
          message
        }];
        const expected = getExpectedMessage(getExpected(issue.ast), format(issue.actual));
        return [{
          path,
          message: expected
        }];
      }
      return issue.issues.flatMap((issue2) => toDefaultIssues(issue2, path, leafHook, checkHook));
    }
    default:
      return [{
        path,
        message: leafHook(issue)
      }];
  }
}
function formatCheck(check) {
  const expected = check.annotations?.expected;
  if (typeof expected === "string") return expected;
  switch (check._tag) {
    case "Filter":
      return "<filter>";
    case "FilterGroup":
      return check.checks.map((check2) => formatCheck(check2)).join(" & ");
  }
}
function makeFormatterDefault() {
  return (issue) => toDefaultIssues(issue, [], defaultLeafHook, defaultCheckHook).map(formatDefaultIssue).join("\n");
}
var defaultFormatter = /* @__PURE__ */ makeFormatterDefault();
function formatDefaultIssue(issue) {
  let out = issue.message;
  if (issue.path && issue.path.length > 0) {
    const path = formatPath(issue.path);
    out += `
  at ${path}`;
  }
  return out;
}
function findMessage(issue) {
  switch (issue._tag) {
    case "InvalidType":
    case "OneOf":
    case "Composite":
    case "AnyOf":
      return getMessageAnnotation(issue.ast.annotations);
    case "InvalidValue":
    case "Forbidden":
      return getMessageAnnotation(issue.annotations);
    case "MissingKey":
      return getMessageAnnotation(issue.annotations, "messageMissingKey");
    case "UnexpectedKey":
      return getMessageAnnotation(issue.ast.annotations, "messageUnexpectedKey");
    case "Filter":
      return getMessageAnnotation(issue.filter.annotations);
    case "Encoding":
      return findMessage(issue.issue);
  }
}
function getMessageAnnotation(annotations, type = "message") {
  const message = annotations?.[type];
  if (typeof message === "string") return message;
}
function formatOption(actual) {
  if (isNone2(actual)) return "no value provided";
  return format(actual.value);
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/schema/cause.js
function getSchemaIssue(cause) {
  let issue;
  for (const reason of cause.reasons) {
    if (!isFailReason2(reason) || !isIssue(reason.error)) {
      return void 0;
    }
    issue ??= reason.error;
  }
  return issue;
}
function getSchemaIssueOrThrow(cause, message) {
  const issue = getSchemaIssue(cause);
  if (issue === void 0) {
    throw new Error(message, {
      cause
    });
  }
  return issue;
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/SchemaGetter.js
var Getter = class _Getter extends Class {
  run;
  constructor(run2) {
    super();
    this.run = run2;
  }
  map(f) {
    return new _Getter((oe, options) => this.run(oe, options).pipe(mapEager2(map(f))));
  }
  compose(other) {
    if (isPassthrough(this)) {
      return other;
    }
    if (isPassthrough(other)) {
      return this;
    }
    return new _Getter((oe, options) => this.run(oe, options).pipe(flatMapEager2((ot) => other.run(ot, options))));
  }
};
var passthrough_ = /* @__PURE__ */ new Getter(succeed4);
function isPassthrough(getter) {
  return getter.run === passthrough_.run;
}
function passthrough() {
  return passthrough_;
}
function onSome(f) {
  return new Getter((oe, options) => isNone2(oe) ? succeedNone2 : f(oe.value, options));
}
function transform(f) {
  return transformOptional(map(f));
}
function transformOrFail(f) {
  return onSome((e, options) => f(e, options).pipe(mapEager2(some2)));
}
function transformOptional(f) {
  return new Getter((oe) => succeed4(f(oe)));
}
function withDefault(defaultValue) {
  return new Getter((o) => {
    const filtered = filter(o, isNotUndefined);
    return isSome2(filtered) ? succeed4(filtered) : mapEager2(defaultValue, some2);
  });
}
function String2() {
  return transform(globalThis.String);
}
function Number3() {
  return transform(globalThis.Number);
}
function encodeBase642() {
  return transform(encodeBase64);
}
function decodeBase642() {
  return transformOrFail((input) => mapErrorEager2(fromResult2(decodeBase64(input)), (e) => new InvalidValue(some2(input), {
    message: e.message
  })));
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/SchemaTransformation.js
var TypeId5 = "~effect/SchemaTransformation/Transformation";
var Transformation = class _Transformation {
  [TypeId5] = TypeId5;
  _tag = "Transformation";
  decode;
  encode;
  constructor(decode, encode) {
    this.decode = decode;
    this.encode = encode;
  }
  flip() {
    return new _Transformation(this.encode, this.decode);
  }
  compose(other) {
    return new _Transformation(this.decode.compose(other.decode), other.encode.compose(this.encode));
  }
};
function isTransformation(u) {
  return hasProperty(u, TypeId5) && u[TypeId5] === TypeId5;
}
var make4 = (options) => {
  if (isTransformation(options)) {
    return options;
  }
  return new Transformation(options.decode, options.encode);
};
function transformOrFail2(options) {
  return new Transformation(transformOrFail(options.decode), transformOrFail(options.encode));
}
function transform2(options) {
  return new Transformation(transform(options.decode), transform(options.encode));
}
var passthrough_2 = /* @__PURE__ */ new Transformation(/* @__PURE__ */ passthrough(), /* @__PURE__ */ passthrough());
function passthrough2() {
  return passthrough_2;
}
var numberFromString = /* @__PURE__ */ new Transformation(/* @__PURE__ */ Number3(), /* @__PURE__ */ String2());
var urlFromString = /* @__PURE__ */ transformOrFail2({
  decode: (s) => URL.canParse(s) ? succeed4(new URL(s)) : fail5(new InvalidValue(some2(s), {
    message: `Invalid URL string: ${s}`
  })),
  encode: (url) => succeed4(url.href)
});
var uint8ArrayFromBase64String = /* @__PURE__ */ new Transformation(/* @__PURE__ */ decodeBase642(), /* @__PURE__ */ encodeBase642());

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/SchemaAST.js
function makeGuard(tag2) {
  return (ast) => ast._tag === tag2;
}
var isDeclaration = /* @__PURE__ */ makeGuard("Declaration");
var isNever2 = /* @__PURE__ */ makeGuard("Never");
var isLiteral = /* @__PURE__ */ makeGuard("Literal");
var isUniqueSymbol = /* @__PURE__ */ makeGuard("UniqueSymbol");
var isArrays = /* @__PURE__ */ makeGuard("Arrays");
var isObjects = /* @__PURE__ */ makeGuard("Objects");
var isUnion = /* @__PURE__ */ makeGuard("Union");
var Link = class {
  to;
  transformation;
  constructor(to, transformation) {
    this.to = to;
    this.transformation = transformation;
  }
};
var defaultParseOptions = {};
var Context = class {
  isOptional;
  isMutable;
  /** Used for constructor default values (e.g. `withConstructorDefault` API) */
  defaultValue;
  annotations;
  constructor(isOptional2, isMutable2, defaultValue = void 0, annotations = void 0) {
    this.isOptional = isOptional2;
    this.isMutable = isMutable2;
    this.defaultValue = defaultValue;
    this.annotations = annotations;
  }
};
var TypeId6 = "~effect/Schema";
var Base2 = class {
  [TypeId6] = TypeId6;
  annotations;
  checks;
  encoding;
  context;
  constructor(annotations = void 0, checks = void 0, encoding = void 0, context2 = void 0) {
    this.annotations = annotations;
    this.checks = checks;
    this.encoding = encoding;
    this.context = context2;
  }
  toString() {
    return `<${this._tag}>`;
  }
};
var Declaration = class _Declaration extends Base2 {
  _tag = "Declaration";
  typeParameters;
  run;
  encodingChecks;
  constructor(typeParameters, run2, annotations, checks, encoding, context2, encodingChecks) {
    super(annotations, checks, encoding, context2);
    this.typeParameters = typeParameters;
    this.run = run2;
    this.encodingChecks = encodingChecks;
  }
  /** @internal */
  getParser() {
    const run2 = this.run(this.typeParameters);
    return (oinput, options) => {
      if (isNone2(oinput)) return succeedNone2;
      return mapEager2(run2(oinput.value, this, options), some2);
    };
  }
  _rebuild(recur2, checks, encodingChecks) {
    const tps = mapOrSame(this.typeParameters, recur2);
    return tps === this.typeParameters && checks === this.checks && encodingChecks === this.encodingChecks ? this : new _Declaration(tps, this.run, this.annotations, checks, void 0, this.context, encodingChecks);
  }
  /** @internal */
  recur(recur2) {
    return this._rebuild(recur2, this.checks, this.encodingChecks);
  }
  /** @internal */
  flip(recur2) {
    return this._rebuild(recur2, this.encodingChecks, this.checks);
  }
  /** @internal */
  getExpected() {
    const expected = this.annotations?.expected;
    if (typeof expected === "string") return expected;
    return "<Declaration>";
  }
};
var Null = class extends Base2 {
  _tag = "Null";
  /** @internal */
  getParser() {
    return fromConst(this, null);
  }
  /** @internal */
  getExpected() {
    return "null";
  }
};
var null_ = /* @__PURE__ */ new Null();
var Never = class extends Base2 {
  _tag = "Never";
  /** @internal */
  getParser() {
    return fromRefinement(this, isNever);
  }
  /** @internal */
  getExpected() {
    return "never";
  }
};
var never2 = /* @__PURE__ */ new Never();
var Unknown = class extends Base2 {
  _tag = "Unknown";
  /** @internal */
  getParser() {
    return fromRefinement(this, isUnknown);
  }
  /** @internal */
  getExpected() {
    return "unknown";
  }
};
var unknown = /* @__PURE__ */ new Unknown();
var Literal = class extends Base2 {
  _tag = "Literal";
  literal;
  constructor(literal, annotations, checks, encoding, context2) {
    super(annotations, checks, encoding, context2);
    if (typeof literal === "number" && !globalThis.Number.isFinite(literal)) {
      throw new Error(`A numeric literal must be finite, got ${format(literal)}`);
    }
    this.literal = literal;
  }
  /** @internal */
  getParser() {
    return fromConst(this, this.literal);
  }
  /** @internal */
  matchPart(s, _options) {
    return s === globalThis.String(this.literal) ? this.literal : void 0;
  }
  /** @internal */
  toCodecJson() {
    return typeof this.literal === "bigint" ? literalToString(this) : this;
  }
  /** @internal */
  toCodecStringTree() {
    return typeof this.literal === "string" ? this : literalToString(this);
  }
  /** @internal */
  getExpected() {
    return typeof this.literal === "string" ? JSON.stringify(this.literal) : globalThis.String(this.literal);
  }
};
function literalToString(ast) {
  const literalAsString = globalThis.String(ast.literal);
  return replaceEncoding(ast, [new Link(new Literal(literalAsString), new Transformation(transform(() => ast.literal), transform(() => literalAsString)))]);
}
var String3 = class extends Base2 {
  _tag = "String";
  /** @internal */
  getParser() {
    return fromRefinement(this, isString);
  }
  /** @internal */
  matchPart(s, options) {
    return applyTemplateLiteralPartChecks(this, s, options);
  }
  /** @internal */
  getExpected() {
    return "string";
  }
};
var string2 = /* @__PURE__ */ new String3();
var Number4 = class extends Base2 {
  _tag = "Number";
  /** @internal */
  getParser() {
    return fromRefinement(this, isNumber);
  }
  /** @internal */
  matchKey(s, options) {
    return this._match(isStringNumberRegExp, s, options);
  }
  /** @internal */
  matchPart(s, options) {
    return this._match(isStringFiniteRegExp, s, options);
  }
  _match(regexp, s, options) {
    return regexp.test(s) ? applyTemplateLiteralPartChecks(this, globalThis.Number(s), options) : void 0;
  }
  /** @internal */
  toCodecJson() {
    if (this.checks && (hasCheck(this.checks, "effect/schema/isFinite") || hasCheck(this.checks, "effect/schema/isInt"))) {
      return this;
    }
    return replaceEncoding(this, [numberToJson(this.checks)]);
  }
  /** @internal */
  toCodecStringTree() {
    if (this.toCodecJson() === this) {
      return replaceEncoding(this, [finiteToString]);
    }
    return replaceEncoding(this, [numberToString]);
  }
  /** @internal */
  getExpected() {
    return "number";
  }
};
function hasCheck(checks, id) {
  return checks.some((check) => check.annotations?.representation?.id === id || check._tag === "FilterGroup" && hasCheck(check.checks, id));
}
function numberToJson(checks) {
  const encodedFinite = checks === void 0 ? finite : appendChecks(finite, checks);
  return new Link(new Union([encodedFinite, nonFiniteLiterals], "anyOf"), new Transformation(Number3(), transform((n) => globalThis.Number.isFinite(n) ? n : globalThis.String(n))));
}
var number2 = /* @__PURE__ */ new Number4();
var Boolean2 = class extends Base2 {
  _tag = "Boolean";
  /** @internal */
  getParser() {
    return fromRefinement(this, isBoolean);
  }
  /** @internal */
  getExpected() {
    return "boolean";
  }
};
var boolean = /* @__PURE__ */ new Boolean2();
var Arrays = class _Arrays extends Base2 {
  _tag = "Arrays";
  isMutable;
  elements;
  rest;
  encodingChecks;
  constructor(isMutable2, elements, rest, annotations, checks, encoding, context2, encodingChecks) {
    super(annotations, checks, encoding, context2);
    this.isMutable = isMutable2;
    this.elements = elements;
    this.rest = rest;
    this.encodingChecks = encodingChecks;
    const i = elements.findIndex(isOptional);
    if (i !== -1 && (elements.slice(i + 1).some((e) => !isOptional(e)) || rest.length > 1)) {
      throw new Error("A required element cannot follow an optional element. ts(1257)");
    }
    if (rest.length > 1 && rest.slice(1).some(isOptional)) {
      throw new Error("An optional element cannot follow a rest element. ts(1266)");
    }
  }
  /** @internal */
  getParser(recur2) {
    const ast = this;
    const elements = ast.elements.map((ast2) => ({
      ast: ast2,
      parser: recur2(ast2)
    }));
    const rest = ast.rest.map((ast2) => ({
      ast: ast2,
      parser: recur2(ast2)
    }));
    const elementLen = elements.length;
    const [head, ...tail] = rest;
    const tailLen = tail.length;
    function getParser(tailThreshold, index) {
      if (index < elementLen) {
        return elements[index];
      } else if (index >= tailThreshold) {
        return tail[index - tailThreshold];
      }
      return head;
    }
    return fnUntracedEager2(function* (oinput, options) {
      if (oinput._tag === "None") {
        return oinput;
      }
      const input = oinput.value;
      if (!Array.isArray(input)) {
        return yield* fail5(new InvalidType(ast, oinput));
      }
      const len = input.length;
      const state = {
        ast,
        getParser,
        oinput,
        len,
        tailThreshold: resolveTailThreshold(len, elementLen, tailLen),
        output: new globalThis.Array(len),
        issues: void 0,
        options
      };
      const concurrency = resolveConcurrency(options?.concurrency);
      const eff = parseArray(state, input, {
        concurrency: concurrency?.concurrency,
        end: ast.rest.length === 0 ? elementLen : Math.max(len, elementLen + tailLen)
      });
      if (eff) yield* eff;
      if (ast.rest.length === 0 && len > elementLen) {
        for (let i = elementLen; i <= len - 1; i++) {
          const issue = new Pointer([i], new UnexpectedKey(ast, input[i]));
          if (options.errors === "all") {
            if (state.issues) state.issues.push(issue);
            else state.issues = [issue];
          } else {
            return yield* fail5(new Composite(ast, oinput, [issue]));
          }
        }
      }
      if (state.issues) {
        return yield* fail5(new Composite(ast, oinput, state.issues));
      }
      return some2(state.output);
    });
  }
  _rebuild(recur2, checks, encodingChecks) {
    const elements = mapOrSame(this.elements, recur2);
    const rest = mapOrSame(this.rest, recur2);
    return elements === this.elements && rest === this.rest && checks === this.checks && encodingChecks === this.encodingChecks ? this : new _Arrays(this.isMutable, elements, rest, this.annotations, checks, void 0, this.context, encodingChecks);
  }
  /** @internal */
  recur(recur2) {
    return this._rebuild(recur2, this.checks, this.encodingChecks);
  }
  /** @internal */
  flip(recur2) {
    return this._rebuild(recur2, this.encodingChecks, this.checks);
  }
  /** @internal */
  getExpected() {
    return "array";
  }
};
var parseArray = /* @__PURE__ */ iterateEager()({
  onItem(s, item, i) {
    const value = i < s.len ? some2(item) : none2();
    return s.getParser(s.tailThreshold, i).parser(value, s.options);
  },
  step(s, _, exit3, i) {
    if (exit3._tag === "Failure") {
      return wrapPropertyKeyIssue(s, s.ast, i, exit3);
    } else if (exit3.value._tag === "Some") {
      s.output[i] = exit3.value.value;
    } else {
      const p = s.getParser(s.tailThreshold, i);
      if (isOptional(p.ast)) return;
      const issue = new Pointer([i], new MissingKey(p.ast.context?.annotations));
      if (s.options.errors === "all") {
        if (s.issues) s.issues.push(issue);
        else s.issues = [issue];
      } else {
        return fail4(new Composite(s.ast, s.oinput, [issue]));
      }
    }
  }
});
function resolveTailThreshold(inputLen, elementLen, tailLen) {
  return Math.max(elementLen, inputLen - tailLen);
}
var resolveConcurrency = (value) => {
  value = value === "unbounded" ? Infinity : value ?? 1;
  return value > 1 ? {
    concurrency: value
  } : void 0;
};
var wrapPropertyKeyIssue = (s, ast, key, exit3) => {
  if (exit3.cause.reasons.length === 0) {
    return exit3;
  }
  const issue = getSchemaIssue(exit3.cause);
  if (issue === void 0) {
    return failCause2(map4(exit3.cause, (issue2) => new Composite(ast, s.oinput, [new Pointer([key], issue2)])));
  }
  const pointer = new Pointer([key], issue);
  if (s.options.errors === "all") {
    if (s.issues) s.issues.push(pointer);
    else s.issues = [pointer];
  } else {
    return fail4(new Composite(ast, s.oinput, [pointer]));
  }
};
var FINITE_PATTERN = "[+-]?\\d*\\.?\\d+(?:[Ee][+-]?\\d+)?";
function getIndexSignatureKeys(input, parameter, options = defaultParseOptions) {
  let stringKeys;
  let symbolKeys;
  function go(parameter2) {
    switch (parameter2._tag) {
      case "String":
      case "TemplateLiteral":
        return (stringKeys ??= Object.keys(input)).filter((k) => parameter2.matchPart(k, options) !== void 0);
      case "Number":
        return (stringKeys ??= Object.keys(input)).filter((k) => parameter2.matchKey(k, options) !== void 0);
      case "Symbol":
        return (symbolKeys ??= Object.getOwnPropertySymbols(input)).filter((k) => parameter2.matchKey(k, options) !== void 0);
      case "Union":
        return [...new Set(parameter2.types.flatMap(go))];
      default:
        return [];
    }
  }
  return go(parameterFromPropertyKey(toEncoded(parameter)));
}
var PropertySignature = class {
  name;
  type;
  constructor(name, type) {
    this.name = name;
    this.type = type;
  }
};
var KeyValueCombiner = class _KeyValueCombiner {
  decode;
  encode;
  constructor(decode, encode) {
    this.decode = decode;
    this.encode = encode;
  }
  /** @internal */
  flip() {
    return new _KeyValueCombiner(this.encode, this.decode);
  }
};
function isIndexSignatureParameterSide(ast) {
  switch (ast._tag) {
    case "String":
    case "Number":
    case "Symbol":
    case "TemplateLiteral":
      return true;
    case "Union":
      return ast.types.every(isIndexSignatureParameterSide);
    default:
      return false;
  }
}
function isIndexSignatureParameter(ast) {
  return isIndexSignatureParameterSide(ast) && isIndexSignatureParameterSide(toEncoded(ast));
}
var IndexSignature = class {
  parameter;
  type;
  merge;
  constructor(parameter, type, merge2) {
    if (!isIndexSignatureParameter(parameter)) {
      throw new Error(`Invalid index signature parameter ${parameter._tag}`);
    }
    this.parameter = parameter;
    this.type = type;
    this.merge = merge2;
    if (isOptional(type) && !containsUndefined(type)) {
      throw new Error("Cannot use `Schema.optionalKey` with index signatures, use `Schema.optional` instead.");
    }
  }
};
var Objects = class _Objects extends Base2 {
  _tag = "Objects";
  propertySignatures;
  indexSignatures;
  encodingChecks;
  constructor(propertySignatures, indexSignatures, annotations, checks, encoding, context2, encodingChecks) {
    super(annotations, checks, encoding, context2);
    this.propertySignatures = propertySignatures;
    this.indexSignatures = indexSignatures;
    this.encodingChecks = encodingChecks;
    const duplicates = propertySignatures.map((ps) => ps.name).filter((name, i, arr) => arr.indexOf(name) !== i);
    if (duplicates.length > 0) {
      throw new Error(`Duplicate identifiers: ${JSON.stringify(duplicates)}. ts(2300)`);
    }
  }
  /** @internal */
  getParser(recur2) {
    const ast = this;
    const expectedKeys = [];
    const expectedKeysSet = /* @__PURE__ */ new Set();
    const properties = [];
    for (const ps of ast.propertySignatures) {
      expectedKeys.push(ps.name);
      expectedKeysSet.add(ps.name);
      properties.push({
        ps,
        parser: recur2(ps.type),
        name: ps.name,
        type: ps.type
      });
    }
    const indexCount = ast.indexSignatures.length;
    if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0) {
      return fromRefinement(ast, isNotNullish);
    }
    const parseIndexes = indexCount > 0 ? iterateEager()({
      onItem: fnUntracedEager2(function* (s, [key, is2]) {
        const parserKey = recur2(parameterFromPropertyKey(is2.parameter));
        const effKey = parserKey(some2(key), s.options);
        const exitKey = effectIsExit(effKey) ? effKey : yield* exit2(effKey);
        if (exitKey._tag === "Failure") {
          const eff = wrapPropertyKeyIssue(s, ast, key, exitKey);
          if (eff) yield* eff;
          return;
        }
        const value = some2(s.input[key]);
        const parserValue = recur2(is2.type);
        const effValue = parserValue(value, s.options);
        const exitValue = effectIsExit(effValue) ? effValue : yield* exit2(effValue);
        if (exitValue._tag === "Failure") {
          const eff = wrapPropertyKeyIssue(s, ast, key, exitValue);
          if (eff) yield* eff;
          return;
        } else if (exitKey.value._tag === "Some" && exitValue.value._tag === "Some") {
          const k2 = exitKey.value.value;
          if (expectedKeysSet.has(key) || expectedKeysSet.has(k2)) {
            return;
          }
          const v2 = exitValue.value.value;
          if (is2.merge && is2.merge.decode && Object.hasOwn(s.out, k2)) {
            const [k, v] = is2.merge.decode.combine([k2, s.out[k2]], [k2, v2]);
            assignProperty(s.out, k, v);
          } else {
            assignProperty(s.out, k2, v2);
          }
        }
      }),
      step: (_s, _, exit3) => exit3._tag === "Failure" ? exit3 : void 0
    }) : void 0;
    return fnUntracedEager2(function* (oinput, options) {
      if (oinput._tag === "None") {
        return oinput;
      }
      const input = oinput.value;
      if (!(typeof input === "object" && input !== null && !Array.isArray(input))) {
        return yield* fail5(new InvalidType(ast, oinput));
      }
      const out = {};
      const state = {
        ast,
        oinput,
        input,
        out,
        issues: void 0,
        options
      };
      const errorsAllOption = options.errors === "all";
      const onExcessPropertyError = options.onExcessProperty === "error";
      const onExcessPropertyPreserve = options.onExcessProperty === "preserve";
      let inputKeys;
      if (ast.indexSignatures.length === 0 && (onExcessPropertyError || onExcessPropertyPreserve)) {
        inputKeys = Reflect.ownKeys(input);
        for (let i = 0; i < inputKeys.length; i++) {
          const key = inputKeys[i];
          if (!expectedKeysSet.has(key)) {
            if (onExcessPropertyError) {
              const issue = new Pointer([key], new UnexpectedKey(ast, input[key]));
              if (errorsAllOption) {
                if (state.issues) {
                  state.issues.push(issue);
                } else {
                  state.issues = [issue];
                }
                continue;
              } else {
                return yield* fail5(new Composite(ast, oinput, [issue]));
              }
            } else {
              assignProperty(out, key, input[key]);
            }
          }
        }
      }
      const concurrency = resolveConcurrency(options?.concurrency);
      const eff = parseProperties(state, properties, concurrency);
      if (eff) yield* eff;
      if (parseIndexes) {
        const keyPairs = empty();
        for (let i = 0; i < indexCount; i++) {
          const is2 = ast.indexSignatures[i];
          const keys = getIndexSignatureKeys(input, is2.parameter, options);
          for (let j = 0; j < keys.length; j++) {
            const key = keys[j];
            keyPairs.push([key, is2]);
          }
        }
        const eff2 = parseIndexes(state, keyPairs, concurrency);
        if (eff2) yield* eff2;
      }
      if (state.issues) {
        return yield* fail5(new Composite(ast, oinput, state.issues));
      }
      if (options.propertyOrder === "original") {
        const keys = (inputKeys ?? Reflect.ownKeys(input)).concat(expectedKeys);
        const preserved = {};
        for (const key of keys) {
          if (Object.hasOwn(out, key)) {
            assignProperty(preserved, key, out[key]);
          }
        }
        return some2(preserved);
      }
      return some2(out);
    });
  }
  _rebuild(recur2, recurParameter, flipMerge, checks, encodingChecks) {
    const props = mapOrSame(this.propertySignatures, (ps) => {
      const t = recur2(ps.type);
      return t === ps.type ? ps : new PropertySignature(ps.name, t);
    });
    const indexes = mapOrSame(this.indexSignatures, (is2) => {
      const p = recurParameter(is2.parameter);
      const t = recur2(is2.type);
      const merge2 = flipMerge ? is2.merge?.flip() : is2.merge;
      return p === is2.parameter && t === is2.type && merge2 === is2.merge ? is2 : new IndexSignature(p, t, merge2);
    });
    return props === this.propertySignatures && indexes === this.indexSignatures && checks === this.checks && encodingChecks === this.encodingChecks ? this : new _Objects(props, indexes, this.annotations, checks, void 0, this.context, encodingChecks);
  }
  /** @internal */
  flip(recur2) {
    return this._rebuild(recur2, recur2, true, this.encodingChecks, this.checks);
  }
  /** @internal */
  recur(recur2, recurParameter = recur2) {
    return this._rebuild(recur2, recurParameter, false, this.checks, this.encodingChecks);
  }
  /** @internal */
  getExpected() {
    if (this.propertySignatures.length === 0 && this.indexSignatures.length === 0) return "object | array";
    return "object";
  }
};
var parseProperties = /* @__PURE__ */ iterateEager()({
  onItem(s, p) {
    const value = Object.hasOwn(s.input, p.name) ? some2(s.input[p.name]) : none2();
    return p.parser(value, s.options);
  },
  step(s, p, exit3) {
    if (exit3._tag === "Failure") {
      return wrapPropertyKeyIssue(s, s.ast, p.name, exit3);
    } else if (exit3.value._tag === "Some") {
      assignProperty(s.out, p.name, exit3.value.value);
    } else if (!isOptional(p.type)) {
      const issue = new Pointer([p.name], new MissingKey(p.type.context?.annotations));
      if (s.options.errors === "all") {
        if (s.issues) s.issues.push(issue);
        else s.issues = [issue];
        return;
      } else {
        return fail4(new Composite(s.ast, s.oinput, [issue]));
      }
    }
  }
});
function combineChecks(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [...a, ...b];
}
function struct(fields, checks, annotations) {
  return new Objects(Reflect.ownKeys(fields).map((key) => {
    return new PropertySignature(key, fields[key].ast);
  }), [], annotations, checks);
}
function getAST(self) {
  return self.ast;
}
function tuple(elements, checks = void 0) {
  return new Arrays(false, elements.map((e) => e.ast), [], void 0, checks);
}
function union2(members, mode, checks) {
  return new Union(members.map(getAST), mode, void 0, checks);
}
function getCandidateTypes(ast) {
  switch (ast._tag) {
    case "Null":
      return ["null"];
    case "Undefined":
      return ["undefined"];
    case "String":
    case "TemplateLiteral":
      return ["string"];
    case "Number":
      return ["number"];
    case "Boolean":
      return ["boolean"];
    case "Symbol":
    case "UniqueSymbol":
      return ["symbol"];
    case "BigInt":
      return ["bigint"];
    case "Arrays":
      return ["array"];
    case "ObjectKeyword":
      return ["object", "array", "function"];
    case "Objects":
      return ast.propertySignatures.length || ast.indexSignatures.length ? ["object"] : ["string", "number", "boolean", "symbol", "bigint", "object", "array", "function"];
    case "Enum":
      return Array.from(new Set(ast.enums.map(([, v]) => typeof v)));
    case "Literal":
      return [typeof ast.literal];
    case "Union":
      return Array.from(new Set(ast.types.flatMap(getCandidateTypes)));
    default:
      return ["null", "undefined", "string", "number", "boolean", "symbol", "bigint", "object", "array", "function"];
  }
}
function collectSentinels(ast) {
  switch (ast._tag) {
    default:
      return [];
    case "Declaration": {
      const s = ast.annotations?.[SENTINELS_ANNOTATION_KEY];
      return Array.isArray(s) ? s : [];
    }
    case "Objects":
      return ast.propertySignatures.flatMap((ps) => {
        const type = ps.type;
        if (!isOptional(type)) {
          if (isLiteral(type)) {
            return [{
              key: ps.name,
              literal: type.literal
            }];
          }
          if (isUniqueSymbol(type)) {
            return [{
              key: ps.name,
              literal: type.symbol
            }];
          }
        }
        return [];
      });
    case "Arrays":
      return ast.elements.flatMap((e, i) => {
        return isLiteral(e) && !isOptional(e) ? [{
          key: i,
          literal: e.literal
        }] : [];
      });
    case "Suspend":
      return collectSentinels(ast.thunk());
  }
}
var candidateIndexCache = /* @__PURE__ */ new WeakMap();
function getIndex(types) {
  let idx = candidateIndexCache.get(types);
  if (idx) return idx;
  idx = {};
  for (let i = 0; i < types.length; i++) {
    const a = types[i];
    const encoded = toEncoded(a);
    if (isNever2(encoded)) continue;
    const candidateTypes = getCandidateTypes(encoded);
    const sentinels = collectSentinels(encoded);
    idx.byType ??= {};
    for (const t of candidateTypes) (idx.byType[t] ??= []).push(i);
    if (sentinels.length > 0) {
      idx.bySentinel ??= /* @__PURE__ */ new Map();
      for (const {
        key,
        literal
      } of sentinels) {
        let m = idx.bySentinel.get(key);
        if (!m) idx.bySentinel.set(key, m = /* @__PURE__ */ new Map());
        let arr = m.get(literal);
        if (!arr) m.set(literal, arr = []);
        arr.push(i);
      }
    } else {
      idx.otherwise ??= {};
      for (const t of candidateTypes) (idx.otherwise[t] ??= []).push(i);
    }
  }
  candidateIndexCache.set(types, idx);
  return idx;
}
function filterLiterals(input) {
  return (ast) => {
    const encoded = toEncoded(ast);
    return encoded._tag === "Literal" ? encoded.literal === input : encoded._tag === "UniqueSymbol" ? encoded.symbol === input : true;
  };
}
function getCandidates(input, types) {
  const idx = getIndex(types);
  const runtimeType = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
  if (idx.bySentinel) {
    const base = idx.otherwise?.[runtimeType] ?? [];
    if (runtimeType === "object" || runtimeType === "array") {
      const selected = new Set(base);
      for (const [k, m] of idx.bySentinel) {
        if (Object.hasOwn(input, k)) {
          const match5 = m.get(input[k]);
          if (match5) {
            for (const candidate of match5) selected.add(candidate);
          }
        }
      }
      return Array.from(selected).sort((a, b) => a - b).map((i) => types[i]).filter(filterLiterals(input));
    }
    return base.map((i) => types[i]);
  }
  return (idx.byType?.[runtimeType] ?? []).map((i) => types[i]).filter(filterLiterals(input));
}
var Union = class _Union extends Base2 {
  _tag = "Union";
  types;
  mode;
  encodingChecks;
  constructor(types, mode, annotations, checks, encoding, context2, encodingChecks) {
    super(annotations, checks, encoding, context2);
    this.types = types;
    this.mode = mode;
    this.encodingChecks = encodingChecks;
  }
  /** @internal */
  getParser(recur2) {
    const ast = this;
    return (oinput, options) => {
      if (oinput._tag === "None") {
        return succeed4(oinput);
      }
      const input = oinput.value;
      const candidates = getCandidates(input, ast.types);
      const state = {
        ast,
        recur: recur2,
        oinput,
        input,
        out: void 0,
        successes: [],
        issues: void 0,
        options
      };
      const concurrency = resolveConcurrency(options?.concurrency);
      const eff = parseUnion(state, candidates, concurrency ? {
        ...concurrency,
        orderedStep: true
      } : void 0);
      if (!eff) {
        return state.out ? succeed4(state.out) : fail5(new AnyOf(ast, input, state.issues ?? []));
      }
      return flatMap2(eff, (_) => {
        return state.out ? succeed4(state.out) : fail5(new AnyOf(ast, input, state.issues ?? []));
      });
    };
  }
  _rebuild(recur2, checks, encodingChecks) {
    const types = mapOrSame(this.types, recur2);
    return types === this.types && checks === this.checks && encodingChecks === this.encodingChecks ? this : new _Union(types, this.mode, this.annotations, checks, void 0, this.context, encodingChecks);
  }
  /** @internal */
  recur(recur2) {
    return this._rebuild(recur2, this.checks, this.encodingChecks);
  }
  /** @internal */
  flip(recur2) {
    return this._rebuild(recur2, this.encodingChecks, this.checks);
  }
  /** @internal */
  matchPart(s, options) {
    for (const type of this.types) {
      const out = type.matchPart(s, options);
      if (out !== void 0) return out;
    }
    return void 0;
  }
  /** @internal */
  getExpected(getExpected2) {
    const expected = this.annotations?.expected;
    if (typeof expected === "string") return expected;
    if (this.types.length === 0) return "never";
    const types = this.types.map((type) => {
      const encoded = toEncoded(type);
      switch (encoded._tag) {
        case "Arrays": {
          const literals = encoded.elements.filter(isLiteral);
          if (literals.length > 0) {
            return `${formatIsMutable(encoded.isMutable)}[ ${literals.map((e) => getExpected2(e) + formatIsOptional(e.context?.isOptional)).join(", ")}, ... ]`;
          }
          break;
        }
        case "Objects": {
          const literals = encoded.propertySignatures.filter((ps) => isLiteral(ps.type));
          if (literals.length > 0) {
            return `{ ${literals.map((ps) => `${formatIsMutable(ps.type.context?.isMutable)}${formatPropertyKey(ps.name)}${formatIsOptional(ps.type.context?.isOptional)}: ${getExpected2(ps.type)}`).join(", ")}, ... }`;
          }
          break;
        }
      }
      return getExpected2(encoded);
    });
    return Array.from(new Set(types)).join(" | ");
  }
};
var parseUnion = /* @__PURE__ */ iterateEager()({
  onItem(s, ast) {
    const parser = s.recur(ast);
    return parser(s.oinput, s.options);
  },
  step(s, candidate, exit3) {
    if (exit3._tag === "Failure") {
      const issue = getSchemaIssue(exit3.cause);
      if (issue === void 0) {
        return exit3;
      }
      if (s.issues) s.issues.push(issue);
      else s.issues = [issue];
    } else {
      if (s.out && s.ast.mode === "oneOf") {
        s.successes.push(candidate);
        return fail4(new OneOf(s.ast, s.input, s.successes));
      }
      s.out = exit3.value;
      s.successes.push(candidate);
      if (s.ast.mode === "anyOf") {
        return void_2;
      }
    }
  }
});
var nonFiniteLiterals = /* @__PURE__ */ new Union([/* @__PURE__ */ new Literal("Infinity"), /* @__PURE__ */ new Literal("-Infinity"), /* @__PURE__ */ new Literal("NaN")], "anyOf");
function formatIsMutable(isMutable2) {
  return isMutable2 ? "" : "readonly ";
}
function formatIsOptional(isOptional2) {
  return isOptional2 ? "?" : "";
}
var Filter2 = class _Filter extends Class {
  _tag = "Filter";
  run;
  annotations;
  /**
   * Whether the parsing process should be aborted after this check has failed.
   */
  aborted;
  constructor(run2, annotations = void 0, aborted = false) {
    super();
    this.run = run2;
    this.annotations = annotations;
    this.aborted = aborted;
  }
  annotate(annotations) {
    return new _Filter(this.run, {
      ...this.annotations,
      ...annotations
    }, this.aborted);
  }
  abort() {
    return new _Filter(this.run, this.annotations, true);
  }
  and(other, annotations) {
    return new FilterGroup([this, other], annotations);
  }
};
var FilterGroup = class _FilterGroup extends Class {
  _tag = "FilterGroup";
  checks;
  annotations;
  constructor(checks, annotations = void 0) {
    super();
    this.checks = checks;
    this.annotations = annotations;
  }
  annotate(annotations) {
    return new _FilterGroup(this.checks, {
      ...this.annotations,
      ...annotations
    });
  }
  and(other, annotations) {
    return new _FilterGroup([this, other], annotations);
  }
};
function makeFilter(filter3, annotations, aborted = false) {
  return new Filter2((input, ast, options) => make3(input, ast, filter3(input, ast, options)), annotations, aborted);
}
function isFinite(annotations) {
  return makeFilter((n) => globalThis.Number.isFinite(n), {
    expected: "a finite number",
    representation: {
      id: "effect/schema/isFinite",
      payload: null
    },
    toJsonSchema: () => ({
      type: "number"
    }),
    toCode: () => ({
      runtime: "Schema.isFinite()"
    }),
    arbitrary: {
      constraint: {
        noInfinity: true,
        noNaN: true
      }
    },
    ...annotations
  });
}
var finite = /* @__PURE__ */ appendChecks(number2, [/* @__PURE__ */ isFinite()]);
function isPattern(regExp, annotations) {
  const source = regExp.source;
  return makeFilter((s) => regExp.test(s), {
    expected: `a string matching the RegExp ${source}`,
    representation: {
      id: "effect/schema/isPattern",
      payload: {
        source,
        flags: regExp.flags
      }
    },
    toJsonSchema: () => ({
      pattern: source
    }),
    arbitrary: {
      constraint: {
        patterns: [regExp.source]
      }
    },
    ...annotations
  });
}
function modifyOwnPropertyDescriptors(ast, f) {
  const d = Object.getOwnPropertyDescriptors(ast);
  f(d);
  return Object.create(Object.getPrototypeOf(ast), d);
}
function replaceEncoding(ast, encoding) {
  if (ast.encoding === encoding) {
    return ast;
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.encoding.value = encoding;
  });
}
function replaceContext(ast, context2) {
  if (ast.context === context2) {
    return ast;
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.context.value = context2;
  });
}
function getLastEncoding(ast) {
  return ast.encoding ? getLastEncoding(ast.encoding[ast.encoding.length - 1].to) : ast;
}
function annotate(ast, annotations) {
  if (ast.checks) {
    const last = ast.checks[ast.checks.length - 1];
    return replaceChecks(ast, append(ast.checks.slice(0, -1), last.annotate(annotations)));
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.annotations.value = {
      ...d.annotations.value,
      ...annotations
    };
  });
}
function replaceChecks(ast, checks) {
  if (ast._tag === "Suspend" && checks !== void 0) {
    throw new Error("Cannot add checks to Suspend");
  }
  if (ast.checks === checks) {
    return ast;
  }
  return modifyOwnPropertyDescriptors(ast, (d) => {
    d.checks.value = checks;
  });
}
function appendChecks(ast, checks) {
  return replaceChecks(ast, combineChecks(ast.checks, checks));
}
function mapLink(link2, f) {
  const to = f(link2.to);
  return to === link2.to ? link2 : new Link(to, link2.transformation);
}
function updateLastLink(encoding, f) {
  const links = encoding;
  const last = links[links.length - 1];
  const out = mapLink(last, f);
  return out === last ? encoding : append(encoding.slice(0, encoding.length - 1), out);
}
function applyToLastLink(f) {
  return (ast) => ast.encoding ? replaceEncoding(ast, updateLastLink(ast.encoding, f)) : ast;
}
function replaceContextLastLink(ast, context2) {
  return applyToLastLink((ast2) => replaceContext(ast2, context2))(ast);
}
function applyToSelfOrLastLinkEncoding(f) {
  function out(ast) {
    return ast.encoding ? replaceEncoding(ast, updateLastLink(ast.encoding, out)) : f(ast);
  }
  return memoize(out);
}
function appendTransformation(from, transformation, to) {
  const link2 = new Link(from, transformation);
  return replaceEncoding(to, to.encoding ? [...to.encoding, link2] : [link2]);
}
function mapOrSame(as2, f) {
  let changed = false;
  const out = new Array(as2.length);
  for (let i = 0; i < as2.length; i++) {
    const a = as2[i];
    const fa = f(a);
    if (fa !== a) {
      changed = true;
    }
    out[i] = fa;
  }
  return changed ? out : as2;
}
function annotateKey(ast, annotations) {
  const context2 = ast.context ? new Context(ast.context.isOptional, ast.context.isMutable, ast.context.defaultValue, {
    ...ast.context.annotations,
    ...annotations
  }) : new Context(false, false, void 0, annotations);
  return replaceContext(ast, context2);
}
var optionalKeyLastLink = /* @__PURE__ */ applyToLastLink(optionalKey);
function optionalKey(ast) {
  const context2 = ast.context ? ast.context.isOptional === false ? new Context(true, ast.context.isMutable, ast.context.defaultValue, ast.context.annotations) : ast.context : new Context(true, false);
  return optionalKeyLastLink(replaceContext(ast, context2));
}
function withConstructorDefault(ast, defaultValue) {
  const transformation = new Transformation(withDefault(defaultValue), passthrough());
  const encoding = [new Link(unknown, transformation)];
  const context2 = ast.context ? new Context(ast.context.isOptional, ast.context.isMutable, encoding, ast.context.annotations) : new Context(false, false, encoding);
  return replaceContext(ast, context2);
}
function decodeTo(from, to, transformation) {
  return appendTransformation(from, transformation, to);
}
function parseParameter(ast) {
  const literals = [];
  const parameters = [];
  function go(ast2) {
    switch (ast2._tag) {
      case "Literal":
        if (isPropertyKey(ast2.literal)) {
          literals.push(ast2.literal);
        }
        return;
      case "UniqueSymbol":
        literals.push(ast2.symbol);
        return;
      case "Never":
        return;
      case "Union":
        for (let i = 0; i < ast2.types.length; i++) {
          go(ast2.types[i]);
        }
        return;
      default:
        parameters.push(ast2);
    }
  }
  go(ast);
  return {
    literals,
    parameters
  };
}
function record(key, value, keyValueCombiner) {
  const {
    literals,
    parameters: indexSignatures
  } = parseParameter(key);
  return new Objects(literals.map((literal) => new PropertySignature(literal, value)), indexSignatures.map((parameter) => new IndexSignature(parameter, value, keyValueCombiner)));
}
function isOptional(ast) {
  return ast.context?.isOptional ?? false;
}
function isMutable(ast) {
  return ast.context?.isMutable ?? false;
}
function isStructuralCheck(check) {
  return check.annotations?.[STRUCTURAL_ANNOTATION_KEY] === true || check._tag === "FilterGroup" && check.checks.every(isStructuralCheck);
}
function extractStructuralChecks(checks) {
  function extract(check) {
    if (isStructuralCheck(check)) return [check];
    return check._tag === "FilterGroup" ? check.checks.flatMap(extract) : [];
  }
  const out = checks.flatMap(extract);
  return isArrayNonEmpty2(out) ? out : void 0;
}
var toType = /* @__PURE__ */ memoize((ast) => {
  if (ast.encoding) {
    return toType(replaceEncoding(ast, void 0));
  }
  const out = ast;
  const type = out.recur?.(toType) ?? out;
  const encodingChecks = type.encodingChecks;
  if (encodingChecks) {
    const checks = type === ast ? encodingChecks : isArrays(type) || isObjects(type) || isDeclaration(type) && type.typeParameters.length > 0 ? extractStructuralChecks(encodingChecks) : void 0;
    return modifyOwnPropertyDescriptors(type, (d) => {
      d.encodingChecks.value = void 0;
      d.checks.value = combineChecks(type.checks, checks);
    });
  }
  return type;
});
var toEncoded = /* @__PURE__ */ memoize((ast) => {
  return toType(flip2(ast));
});
function flipEncoding(ast, encoding) {
  const links = encoding;
  const len = links.length;
  const last = links[len - 1];
  const ls = [new Link(flip2(replaceEncoding(ast, void 0)), links[0].transformation.flip())];
  for (let i = 1; i < len; i++) {
    ls.unshift(new Link(flip2(links[i - 1].to), links[i].transformation.flip()));
  }
  const to = flip2(last.to);
  if (to.encoding) {
    return replaceEncoding(to, [...to.encoding, ...ls]);
  } else {
    return replaceEncoding(to, ls);
  }
}
var flip2 = /* @__PURE__ */ memoize((ast) => {
  if (ast.encoding) {
    return flipEncoding(ast, ast.encoding);
  }
  const out = ast;
  return out.flip?.(flip2) ?? out.recur?.(flip2) ?? out;
});
function containsUndefined(ast) {
  switch (ast._tag) {
    case "Undefined":
      return true;
    case "Union":
      return ast.types.some(containsUndefined);
    default:
      return false;
  }
}
function fromConst(ast, value) {
  const succeed6 = succeedSome2(value);
  return (oinput) => {
    if (oinput._tag === "None") {
      return succeedNone2;
    }
    return oinput.value === value ? succeed6 : fail5(new InvalidType(ast, oinput));
  };
}
function fromRefinement(ast, refinement) {
  return (oinput) => {
    if (oinput._tag === "None") {
      return succeedNone2;
    }
    return refinement(oinput.value) ? succeed4(oinput) : fail5(new InvalidType(ast, oinput));
  };
}
function applyTemplateLiteralPartChecks(ast, value, options) {
  if (options?.disableChecks || ast.checks === void 0) return value;
  const issues = [];
  collectIssues(ast.checks, value, issues, ast, options);
  return issues.length === 0 ? value : void 0;
}
var parameterFromPropertyKey = /* @__PURE__ */ applyToSelfOrLastLinkEncoding((ast) => {
  switch (ast._tag) {
    default:
      return ast;
    case "Number":
      return ast.toCodecStringTree();
    case "Union":
      return ast.recur(parameterFromPropertyKey);
  }
});
var parameterFromString = /* @__PURE__ */ applyToSelfOrLastLinkEncoding((ast) => {
  switch (ast._tag) {
    default:
      return ast;
    case "Symbol":
    case "UniqueSymbol":
      return ast.toCodecStringTree();
    case "Union":
      return ast.recur(parameterFromString);
  }
});
var STRING_PATTERN = "[\\s\\S]*?";
var isStringFiniteRegExp = /* @__PURE__ */ new globalThis.RegExp(`^${FINITE_PATTERN}$`);
var isStringNumberRegExp = /* @__PURE__ */ new globalThis.RegExp(`^(?:${FINITE_PATTERN}|Infinity|-Infinity|NaN)$`);
function isStringFinite(annotations) {
  return isPattern(isStringFiniteRegExp, {
    expected: "a string representing a finite number",
    representation: {
      id: "effect/schema/isStringFinite",
      payload: null
    },
    toJsonSchema: () => ({
      pattern: isStringFiniteRegExp.source
    }),
    ...annotations
  });
}
var finiteString = /* @__PURE__ */ appendChecks(string2, [/* @__PURE__ */ isStringFinite()]);
var finiteToString = /* @__PURE__ */ new Link(finiteString, numberFromString);
var numberToString = /* @__PURE__ */ new Link(/* @__PURE__ */ new Union([finiteString, nonFiniteLiterals], "anyOf"), numberFromString);
var BIGINT_PATTERN = "-?\\d+";
var isStringBigIntRegExp = /* @__PURE__ */ new globalThis.RegExp(`^${BIGINT_PATTERN}$`);
var REGEXP_PATTERN = "Symbol\\((.*)\\)";
var isStringSymbolRegExp = /* @__PURE__ */ new globalThis.RegExp(`^${REGEXP_PATTERN}$`);
function collectIssues(checks, value, issues, ast, options) {
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i];
    if (check._tag === "FilterGroup") {
      collectIssues(check.checks, value, issues, ast, options);
    } else {
      const issue = check.run(value, ast, options);
      if (issue) {
        issues.push(new Filter(value, check, issue));
        if (check.aborted || options?.errors !== "all") {
          return;
        }
      }
    }
  }
}
var ClassTypeId = "~effect/Schema/Class";
function isJsonLeaf(u) {
  return u === null || typeof u === "string" || typeof u === "boolean" || typeof u === "number" && globalThis.Number.isFinite(u);
}
function isStringTreeLeaf(u) {
  return u === void 0 || typeof u === "string";
}
function isTree(u, isLeaf) {
  const cache = /* @__PURE__ */ new WeakMap();
  const stack = [];
  outer: while (true) {
    if (typeof u !== "object" || u === null) {
      if (!isLeaf(u)) {
        return false;
      }
    } else {
      const value = u;
      const cached2 = cache.get(value);
      if (cached2 === false) {
        return false;
      }
      if (cached2 === void 0) {
        const isArray2 = Array.isArray(value);
        if (!isArray2) {
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== null && prototype !== Object.prototype && Object.getPrototypeOf(prototype) !== null) {
            return false;
          }
        }
        cache.set(value, false);
        stack.push({
          value,
          keys: isArray2 ? value.length : Object.keys(value),
          index: 0
        });
      }
    }
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const keys = frame.keys;
      if (typeof keys === "number") {
        if (frame.index < keys) {
          u = frame.value[frame.index++];
          continue outer;
        }
      } else if (frame.index < keys.length) {
        u = frame.value[keys[frame.index++]];
        continue outer;
      }
      cache.set(frame.value, true);
      stack.pop();
    }
    return true;
  }
}
function isJson(u) {
  return isTree(u, isJsonLeaf);
}
var Json = /* @__PURE__ */ new Declaration([], () => (input, ast) => isJson(input) ? succeed4(input) : fail5(new InvalidType(ast, some2(input))), {
  representation: {
    id: "effect/schema/Json",
    payload: null
  },
  expected: "JSON value",
  toCodecJson: () => void 0,
  toCodecStringTree: () => unknownToStringTree,
  toArbitrary: () => (fc) => fc.jsonValue()
});
var unknownToJson = /* @__PURE__ */ new Link(Json, /* @__PURE__ */ passthrough2());
var objectKeywordToJson = /* @__PURE__ */ new Link(/* @__PURE__ */ new Union([/* @__PURE__ */ new Arrays(false, [], [Json]), /* @__PURE__ */ new Objects([], [/* @__PURE__ */ new IndexSignature(string2, Json, void 0)])], "anyOf"), /* @__PURE__ */ passthrough2());
function isStringTree(u) {
  return isTree(u, isStringTreeLeaf);
}
var StringTree = /* @__PURE__ */ new Declaration([], () => (input, ast) => isStringTree(input) ? succeed4(input) : fail5(new InvalidType(ast, some2(input))), {
  expected: "StringTree",
  toCodecStringTree: () => void 0
});
var unknownToStringTree = /* @__PURE__ */ new Link(StringTree, /* @__PURE__ */ passthrough2());

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/SchemaError.js
var TypeId7 = "~effect/SchemaError/SchemaError";
var SchemaError = class extends (/* @__PURE__ */ TaggedError2("SchemaError")) {
  [TypeId7] = TypeId7;
  constructor(issue) {
    super({
      issue
    });
  }
  get message() {
    return this.issue.toString();
  }
  toString() {
    return `SchemaError(${this.message})`;
  }
};
function isSchemaError(u) {
  return hasProperty(u, TypeId7) && u[TypeId7] === TypeId7;
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/SchemaParser.js
var toConstructorAST = /* @__PURE__ */ memoize((ast) => {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.[ClassTypeId];
      if (isFunction(getLink)) {
        const link2 = getLink(ast.typeParameters);
        return replaceEncoding(ast, [mapLink(link2, toConstructorAST)]);
      }
      return ast;
    }
    case "Objects":
    case "Arrays":
      return ast.recur((ast2) => {
        const defaultValue = ast2.context?.defaultValue;
        if (defaultValue) {
          const out = toConstructorAST(ast2);
          return replaceEncoding(out, out.encoding ? [...out.encoding, ...defaultValue] : defaultValue);
        }
        return toConstructorAST(ast2);
      });
    case "Suspend":
      return ast.recur(toConstructorAST);
    default:
      return ast;
  }
});
function makeEffect(schema) {
  const ast = toConstructorAST(toType(schema.ast));
  const parser = run(ast);
  return (input, options) => {
    return parser(input, options?.disableChecks ? options?.parseOptions ? {
      ...options.parseOptions,
      disableChecks: true
    } : {
      disableChecks: true
    } : options?.parseOptions);
  };
}
function makeOption(schema) {
  const parser = makeEffect(schema);
  return (input, options) => {
    const exit3 = runSyncExit2(parser(input, options));
    if (isSuccess3(exit3)) {
      return some2(exit3.value);
    }
    getSchemaIssueOrThrow(exit3.cause, "Option adapter can only return none for schema issues");
    return none2();
  };
}
function make5(schema) {
  const parser = makeEffect(schema);
  return (input, options) => {
    const exit3 = runSyncExit2(parser(input, options));
    if (isSuccess3(exit3)) {
      return exit3.value;
    }
    const issue = getSchemaIssueOrThrow(exit3.cause, "Constructor adapter can only throw schema issues");
    throw new Error(issue.toString(), {
      cause: issue
    });
  };
}
function decodeUnknownEffect(schema, options) {
  const parser = run(schema.ast);
  return options === void 0 ? parser : (input, overrideOptions) => parser(input, mergeParseOptions(options, overrideOptions));
}
var mergeParseOptions = (options, overrideOptions) => overrideOptions === void 0 ? options : {
  ...options,
  ...overrideOptions
};
function run(ast) {
  const parser = recur(ast);
  return (input, options) => flatMapEager2(parser(some2(input), options ?? defaultParseOptions), (oa) => {
    if (oa._tag === "None") {
      return fail5(new InvalidValue(oa));
    }
    return succeed4(oa.value);
  });
}
function mapSchemaIssueEffect(self, f) {
  return catchCause2(self, (cause) => failCauseSync2(() => map4(cause, f)));
}
var recur = /* @__PURE__ */ memoize((ast) => {
  let parser;
  const checks = ast.checks;
  const encoding = ast.encoding;
  const links = encoding;
  const len = links?.length ?? 0;
  const encodingChecks = ast.encodingChecks;
  const astOptions = (checks ? checks[checks.length - 1].annotations : ast.annotations)?.["parseOptions"];
  if (!ast.context && !encoding && !checks && !encodingChecks) {
    return (ou, options) => {
      parser ??= ast.getParser(recur);
      if (astOptions) {
        options = {
          ...options,
          ...astOptions
        };
      }
      return parser(ou, options);
    };
  }
  return (ou, options) => {
    if (astOptions) {
      options = {
        ...options,
        ...astOptions
      };
    }
    let srou;
    if (links) {
      for (let i = len - 1; i >= 0; i--) {
        const link2 = links[i];
        const to = link2.to;
        const parser2 = recur(to);
        srou = srou ? flatMapEager2(srou, (ou2) => parser2(ou2, options)) : parser2(ou, options);
        if (link2.transformation._tag === "Transformation") {
          const getter = link2.transformation.decode;
          srou = flatMapEager2(srou, (ou2) => getter.run(ou2, options));
        } else {
          srou = link2.transformation.decode(srou, options);
        }
      }
      srou = mapSchemaIssueEffect(srou, (issue) => new Encoding(ast, ou, issue));
    }
    parser ??= ast.getParser(recur);
    const parseLocal = (localOu) => {
      let sroa2 = parser(localOu, options);
      if (encodingChecks && !options?.disableChecks) {
        sroa2 = flatMapEager2(sroa2, (oa) => {
          if (isSome2(localOu) && isSome2(oa)) {
            const issues = [];
            collectIssues(encodingChecks, localOu.value, issues, ast, options);
            if (isArrayNonEmpty2(issues)) {
              return fail5(new Composite(ast, localOu, issues));
            }
          }
          return succeed4(oa);
        });
      }
      if (checks && !options?.disableChecks) {
        sroa2 = flatMapEager2(sroa2, (oa) => {
          if (isSome2(oa)) {
            const value = oa.value;
            const issues = [];
            collectIssues(checks, value, issues, ast, options);
            if (isArrayNonEmpty2(issues)) {
              return fail5(new Composite(ast, oa, issues));
            }
          }
          return succeed4(oa);
        });
      }
      return sroa2;
    };
    const sroa = srou ? flatMapEager2(srou, parseLocal) : parseLocal(ou);
    return sroa;
  };
});

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/schema/schema.js
var TypeId8 = "~effect/Schema/Schema";
var SchemaProto = {
  [TypeId8]: TypeId8,
  pipe() {
    return pipeArguments(this, arguments);
  },
  annotate(annotations) {
    return this.rebuild(annotate(this.ast, annotations));
  },
  annotateKey(annotations) {
    return this.rebuild(annotateKey(this.ast, annotations));
  },
  check(...checks) {
    return this.rebuild(appendChecks(this.ast, checks));
  }
};
function make6(ast, options) {
  function Schema() {
  }
  const self = Object.defineProperties(Object.setPrototypeOf(Schema, SchemaProto), Object.getOwnPropertyDescriptors({
    ...options
  }));
  self.ast = ast;
  self.rebuild = (ast2) => make6(ast2, options);
  const makeEffect2 = makeEffect(self);
  self.makeEffect = (input, options2) => fromIssueEffect(makeEffect2(input, options2));
  self.make = make5(self);
  self.makeOption = makeOption(self);
  return self;
}
function fromIssueEffect(self) {
  return catchCause2(self, (cause) => failCauseSync2(() => map4(cause, (issue) => new SchemaError(issue))));
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Struct.js
var lambda = (f) => f;

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/errors.js
function errorWithPath(message, path) {
  if (path.length > 0) {
    message += `
  at ${formatPath(path)}`;
  }
  return new Error(message);
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/JsonPointer.js
function escapeToken(token) {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/RegExp.js
var RegExp2 = globalThis.RegExp;
var escape = (string3) => string3.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/schema/toJsonSchemaDocument.js
var jsonSchemaAnnotationExcludedKeys = /* @__PURE__ */ new Set([...annotationExcludedKeys, IDENTIFIER_FALLBACK_KEY, ...jsonSchemaAnnotationKeys]);
function collectJsonSchemaAnnotations(annotations, options) {
  if (annotations === void 0) return void 0;
  const out = {};
  const title = annotations.title;
  if (typeof title === "string") out.title = title;
  const description = annotations.description;
  const expected = annotations.expected;
  if (typeof description === "string") out.description = description;
  else if (options?.generateDescriptions === true && typeof expected === "string") out.description = expected;
  const defaultValue = annotations.default;
  if (isJson(defaultValue)) out.default = defaultValue;
  const examples = annotations.examples;
  if (Array.isArray(examples) && isJson(examples)) out.examples = examples;
  const readOnly = annotations.readOnly;
  if (typeof readOnly === "boolean") out.readOnly = readOnly;
  const writeOnly = annotations.writeOnly;
  if (typeof writeOnly === "boolean") out.writeOnly = writeOnly;
  const format2 = annotations.format;
  if (typeof format2 === "string") out.format = format2;
  const contentEncoding = annotations.contentEncoding;
  if (typeof contentEncoding === "string") out.contentEncoding = contentEncoding;
  const contentMediaType = annotations.contentMediaType;
  if (typeof contentMediaType === "string") out.contentMediaType = contentMediaType;
  const contentSchema = annotations.contentSchema;
  if (isJson(contentSchema)) out.contentSchema = contentSchema;
  if (options?.includeAnnotationKey !== void 0) {
    for (const [key, value] of Object.entries(annotations)) {
      if (jsonSchemaAnnotationExcludedKeys.has(key) || !options.includeAnnotationKey(key)) {
        continue;
      }
      if (isJson(value)) assignProperty(out, key, value);
    }
  }
  return Object.keys(out).length === 0 ? void 0 : out;
}
function extractJsonSchemaNumberType(schema) {
  let type = schema.type === "number" || schema.type === "integer" ? schema.type : void 0;
  let out = schema;
  if (type !== void 0) {
    out = {
      ...schema
    };
    delete out.type;
  }
  if (Array.isArray(out.allOf)) {
    const members = [];
    let changed = false;
    for (const member of out.allOf) {
      const extracted = extractJsonSchemaNumberType(member);
      if (extracted.type !== void 0) {
        changed = true;
        if (type === void 0 || extracted.type === "integer") type = extracted.type;
      }
      if (Object.keys(extracted.schema).length > 0) members.push(extracted.schema);
    }
    if (changed) {
      const {
        allOf: _,
        ...rest
      } = out;
      out = members.length === 0 ? rest : {
        ...rest,
        allOf: members
      };
    }
  }
  return {
    type,
    schema: out
  };
}
function isJsonSchemaNumberEncoding(schema) {
  return Array.isArray(schema.anyOf) && schema.anyOf.length === 4 && schema.anyOf[0]?.type === "number" && schema.anyOf.slice(1).every((member) => member.type === "string");
}
function appendJsonSchema(left, right) {
  if (Object.keys(left).length === 0) return right;
  const rightKeys = Object.keys(right);
  if (rightKeys.length === 0) return left;
  const leftType = left.type === "number" || left.type === "integer" ? left.type : void 0;
  const isNumberEncoding = isJsonSchemaNumberEncoding(left);
  if (leftType !== void 0 || isNumberEncoding) {
    const extracted = extractJsonSchemaNumberType(right);
    if (extracted.type !== void 0) {
      const type = leftType === "integer" || extracted.type === "integer" ? "integer" : "number";
      const base = {
        ...left,
        type
      };
      if (isNumberEncoding) delete base.anyOf;
      return Object.keys(extracted.schema).length === 0 ? base : appendJsonSchema(base, extracted.schema);
    }
  }
  const members = Array.isArray(right.allOf) && rightKeys.length === 1 ? right.allOf : [right];
  if (Array.isArray(left.allOf)) {
    return {
      ...left,
      allOf: [...left.allOf, ...members]
    };
  }
  if (typeof left.$ref === "string") {
    return {
      allOf: [left, ...members]
    };
  }
  return {
    ...left,
    allOf: members
  };
}
function compileJsonSchema(representations, rootPaths, references, options) {
  const definitions = {};
  for (const key of Object.keys(references)) {
    assignProperty(definitions, key, recur2(references[key], ["references", key]));
  }
  const schemas = map2(representations, (representation, index) => recur2(representation, rootPaths[index]));
  return {
    dialect: "draft-2020-12",
    schemas,
    definitions
  };
  function annotationSchemas(representation, path) {
    return representation?.schemas?.map((schema, index) => recur2(schema, [...path, "schemas", index])) ?? [];
  }
  function compileCheck(check, type, path) {
    const annotations = check.annotations;
    const callback2 = annotations?.toJsonSchema;
    if (callback2 !== void 0) {
      const schemas2 = annotationSchemas(check.representation, [...path, "representation"]);
      const fragment = callback2({
        type,
        schemas: schemas2
      });
      const ordinary2 = collectJsonSchemaAnnotations(annotations, options);
      return ordinary2 === void 0 ? fragment : {
        ...fragment,
        ...ordinary2
      };
    }
    if (check._tag === "Filter") return void 0;
    const children = check.checks.map((child, index) => compileCheck(child, type, [...path, "checks", index])).filter((child) => child !== void 0);
    if (children.length === 0) return void 0;
    const ordinary = collectJsonSchemaAnnotations(annotations, options);
    return ordinary === void 0 ? {
      allOf: children
    } : {
      allOf: children,
      ...ordinary
    };
  }
  function recur2(representation, path) {
    if (representation._tag === "Reference") {
      if (!Object.hasOwn(references, representation.$ref)) {
        throw errorWithPath(`Invalid reference ${representation.$ref}`, [...path, "$ref"]);
      }
      return {
        $ref: `#/$defs/${escapeToken(representation.$ref)}`
      };
    }
    let output = on(representation, path);
    const ordinary = collectJsonSchemaAnnotations(representation.annotations, options);
    if (ordinary !== void 0) {
      output = {
        ...output,
        ...ordinary
      };
    }
    for (let index = 0; index < representation.checks.length; index++) {
      const type = typeof output.type === "string" && isJsonSchemaType(output.type) ? output.type : void 0;
      const check = compileCheck(representation.checks[index], type, [...path, "checks", index]);
      if (check !== void 0) {
        output = appendJsonSchema(output, check);
      }
    }
    return output;
  }
  function on(representation, path) {
    switch (representation._tag) {
      case "Any":
      case "Unknown":
        return {};
      case "ObjectKeyword":
        return {
          anyOf: [{
            type: "object"
          }, {
            type: "array"
          }]
        };
      case "Void":
      case "Undefined":
      case "Null":
        return {
          type: "null"
        };
      case "BigInt":
        return {
          type: "string",
          allOf: [{
            pattern: "^-?\\d+$"
          }]
        };
      case "Symbol":
      case "UniqueSymbol":
        return {
          type: "string",
          allOf: [{
            pattern: "^Symbol\\((.*)\\)$"
          }]
        };
      case "Declaration": {
        return {};
      }
      case "Suspend":
        return recur2(representation.thunk, [...path, "thunk"]);
      case "Never":
        return {
          not: {}
        };
      case "String":
        return {
          type: "string"
        };
      case "Number":
        return {
          anyOf: [{
            type: "number"
          }, {
            type: "string",
            enum: ["NaN"]
          }, {
            type: "string",
            enum: ["Infinity"]
          }, {
            type: "string",
            enum: ["-Infinity"]
          }]
        };
      case "Boolean":
        return {
          type: "boolean"
        };
      case "Literal": {
        const literal = representation.literal;
        return typeof literal === "bigint" ? {
          type: "string",
          enum: [globalThis.String(literal)]
        } : {
          type: typeof literal,
          enum: [literal]
        };
      }
      case "Enum": {
        const types = representation.enums.map(([title, literal]) => typeof literal === "number" && !globalThis.Number.isFinite(literal) ? {
          type: "string",
          enum: [globalThis.String(literal)],
          title
        } : {
          type: typeof literal,
          enum: [literal],
          title
        });
        return types.length === 0 ? {
          not: {}
        } : {
          anyOf: types
        };
      }
      case "TemplateLiteral":
        return {
          type: "string",
          pattern: `^${representation.parts.map(getPartPattern).join("")}$`
        };
      case "Arrays": {
        if (representation.rest.length > 1) {
          throw errorWithPath("Invalid schema representation document", [...path, "rest"]);
        }
        const out = {
          type: "array"
        };
        let minItems = representation.elements.length;
        const prefixItems = representation.elements.map((element, index) => {
          if (element.isOptional) minItems--;
          const compiled = recur2(element.type, [...path, "elements", index, "type"]);
          const annotations = collectJsonSchemaAnnotations(element.annotations, options);
          return annotations === void 0 ? compiled : appendJsonSchema(compiled, annotations);
        });
        if (prefixItems.length > 0) {
          out.prefixItems = prefixItems;
          out.maxItems = representation.elements.length;
          if (minItems > 0) out.minItems = minItems;
        } else {
          out.items = false;
        }
        if (representation.rest.length === 1) {
          delete out.maxItems;
          const rest = recur2(representation.rest[0], [...path, "rest", 0]);
          if (Object.keys(rest).length > 0) out.items = rest;
          else delete out.items;
        }
        return out;
      }
      case "Objects": {
        if (representation.propertySignatures.length === 0 && representation.indexSignatures.length === 0) {
          return {
            anyOf: [{
              type: "object"
            }, {
              type: "array"
            }]
          };
        }
        const out = {
          type: "object"
        };
        const properties = {};
        const required = [];
        for (let index = 0; index < representation.propertySignatures.length; index++) {
          const property = representation.propertySignatures[index];
          if (typeof property.name !== "string") {
            throw errorWithPath("Invalid schema representation document", [...path, "propertySignatures", index, "name"]);
          }
          const name = property.name;
          const compiled = recur2(property.type, [...path, "propertySignatures", index, "type"]);
          const annotations = collectJsonSchemaAnnotations(property.annotations, options);
          assignProperty(properties, name, annotations === void 0 ? compiled : appendJsonSchema(compiled, annotations));
          if (!property.isOptional) required.push(name);
        }
        if (representation.propertySignatures.length > 0) out.properties = properties;
        if (required.length > 0) out.required = required;
        out.additionalProperties = options?.additionalProperties ?? false;
        const patternProperties = {};
        for (let index = 0; index < representation.indexSignatures.length; index++) {
          const signature = representation.indexSignatures[index];
          let type = recur2(signature.type, [...path, "indexSignatures", index, "type"]);
          if (Object.keys(type).length === 1 && "not" in type) type = false;
          const patterns = getParameterPatterns(signature.parameter, [...path, "indexSignatures", index, "parameter"], /* @__PURE__ */ new Set());
          if (patterns.length === 0) {
            out.additionalProperties = type;
          } else {
            for (const pattern of patterns) assignProperty(patternProperties, pattern, type);
          }
        }
        if (Object.keys(patternProperties).length > 0) {
          out.patternProperties = patternProperties;
          delete out.additionalProperties;
        }
        if (typeof out.additionalProperties === "object" && out.additionalProperties !== null && Object.keys(out.additionalProperties).length === 0) {
          delete out.additionalProperties;
        }
        return out;
      }
      case "Union": {
        const types = representation.types.map((type, index) => recur2(type, [...path, "types", index]));
        if (types.length === 0) return {
          not: {}
        };
        if (types.length > 1) {
          const compacted = compactEnums(types);
          if (compacted !== void 0) return compacted;
        }
        return representation.mode === "anyOf" ? {
          anyOf: types
        } : {
          oneOf: types
        };
      }
    }
  }
  function getParameterPatterns(parameter, path, seenReferences) {
    switch (parameter._tag) {
      case "Reference": {
        if (!Object.hasOwn(references, parameter.$ref)) {
          throw errorWithPath(`Invalid reference ${parameter.$ref}`, [...path, "$ref"]);
        }
        if (seenReferences.has(parameter.$ref)) return [];
        const next = new Set(seenReferences).add(parameter.$ref);
        return getParameterPatterns(references[parameter.$ref], ["references", parameter.$ref], next);
      }
      case "String":
        return collectPatterns(recur2(parameter, path));
      case "TemplateLiteral":
        return [`^${parameter.parts.map(getPartPattern).join("")}$`];
      case "Union":
        return parameter.types.flatMap((type, index) => getParameterPatterns(type, [...path, "types", index], seenReferences));
      default:
        throw errorWithPath("Invalid schema representation document", path);
    }
  }
}
function isJsonSchemaType(input) {
  return input === "string" || input === "number" || input === "boolean" || input === "array" || input === "object" || input === "null" || input === "integer";
}
function compactEnums(schemas) {
  let sharedType = void 0;
  const values = [];
  for (const schema of schemas) {
    const keys = Object.keys(schema);
    if (keys.length !== 2 || schema.type === void 0 || !Array.isArray(schema.enum) || schema.enum.length === 0) {
      return void 0;
    }
    if (sharedType === void 0) sharedType = schema.type;
    else if (schema.type !== sharedType) return void 0;
    values.push(...schema.enum);
  }
  return {
    type: sharedType,
    enum: values
  };
}
function collectPatterns(schema) {
  const patterns = [];
  if (typeof schema.pattern === "string") patterns.push(schema.pattern);
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const members = schema[key];
    if (Array.isArray(members)) {
      for (const member of members) {
        if (typeof member === "object" && member !== null && !Array.isArray(member)) {
          patterns.push(...collectPatterns(member));
        }
      }
    }
  }
  return patterns;
}
function getPartPattern(part) {
  switch (part._tag) {
    case "Literal":
      return escape(globalThis.String(part.literal));
    case "String":
      return STRING_PATTERN;
    case "Number":
      return FINITE_PATTERN;
    case "TemplateLiteral":
      return part.parts.map(getPartPattern).join("");
    case "Union":
      return part.types.map(getPartPattern).join("|");
    default:
      throw errorWithPath("Invalid schema representation document", []);
  }
}
function toJsonSchemaDocument(document, options) {
  const output = compileJsonSchema([document.representation], [["representation"]], document.references, options);
  return {
    dialect: output.dialect,
    schema: output.schemas[0],
    definitions: output.definitions
  };
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/internal/schema/toRepresentation.js
function toRepresentation(ast) {
  const {
    references,
    representations
  } = toRepresentations([ast]);
  return {
    representation: representations[0],
    references
  };
}
function toRepresentations(asts) {
  return lowerASTs(asts, []);
}
function annotationsField(annotations) {
  return annotations === void 0 ? void 0 : {
    annotations
  };
}
function isShareable(ast) {
  return isArrays(ast) || isObjects(ast) || isUnion(ast) && ast.types.some(isShareable);
}
function resolveReferenceIdentifier(ast) {
  const identifier2 = resolveIdentifier(ast);
  if (identifier2 !== void 0) return {
    identifier: identifier2,
    isFallback: false
  };
  const fallback = resolveIdentifierFallback(ast);
  return fallback === void 0 ? void 0 : {
    identifier: `${fallback}JsonEncoding`,
    isFallback: true
  };
}
function hasSameReferenceOwner(self, that) {
  if (self === that) return true;
  const selfKeys = Reflect.ownKeys(self);
  const thatKeys = Reflect.ownKeys(that);
  if (selfKeys.length !== thatKeys.length) return false;
  for (const key of selfKeys) {
    if (key !== "context" && self[key] !== that[key]) return false;
  }
  return true;
}
function lowerASTs(asts, externalDefinitions) {
  const references = {};
  const referenceMap = /* @__PURE__ */ new Map();
  const fallbackReferences = [];
  const referenceOwners = /* @__PURE__ */ new Map();
  const externalReferences = new Set(externalDefinitions.map((definition) => definition.key));
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const shared = /* @__PURE__ */ new Set();
  for (const definition of externalDefinitions) {
    referenceOwners.set(definition.key, definition.body);
    referenceMap.set(definition.original, definition.key);
    referenceMap.set(definition.encoded, definition.key);
  }
  for (const ast of asts) visit(ast);
  for (const definition of externalDefinitions) visit(definition.body);
  const representations = map2(asts, (ast) => recur2(ast));
  for (const definition of externalDefinitions) {
    assignProperty(references, definition.key, recur2(definition.body, definition.key));
  }
  return {
    representations,
    references
  };
  function generateReference(prefix, owner) {
    let candidate = prefix;
    let suffix = 0;
    while (referenceOwners.has(candidate)) {
      candidate = `${prefix}${++suffix}`;
    }
    referenceOwners.set(candidate, owner);
    return candidate;
  }
  function visit(input) {
    const ast = getLastEncoding(input);
    if (visited.has(ast)) {
      if (isShareable(ast)) shared.add(ast);
      return;
    }
    visited.add(ast);
    const referenceIdentifier = resolveReferenceIdentifier(ast);
    if (referenceIdentifier !== void 0 && !referenceIdentifier.isFallback) {
      const owner = referenceOwners.get(referenceIdentifier.identifier);
      if (owner === void 0) {
        referenceOwners.set(referenceIdentifier.identifier, ast);
      } else if (referenceMap.get(ast) !== referenceIdentifier.identifier && !hasSameReferenceOwner(owner, ast)) {
        throw new Error(`Duplicate identifier: ${JSON.stringify(referenceIdentifier.identifier)}`);
      }
    }
    visitChecks(ast.checks);
    switch (ast._tag) {
      case "Declaration":
      case "Arrays":
      case "Objects":
      case "Union":
        ast.recur((child) => {
          visit(child);
          return child;
        });
        break;
      case "TemplateLiteral":
        ast.parts.forEach(visit);
        break;
      case "Suspend":
        visit(ast.thunk());
        break;
    }
  }
  function visitChecks(checks) {
    checks?.forEach((check) => {
      check.annotations?.representation?.schemas?.forEach((schema) => visit(toType(schema)));
      if (check._tag === "FilterGroup") visitChecks(check.checks);
    });
  }
  function recur2(ast, ownedReference) {
    const found = referenceMap.get(ast);
    if (found !== void 0 && found !== ownedReference) {
      return {
        _tag: "Reference",
        $ref: found
      };
    }
    const projected = getLastEncoding(ast);
    if (projected !== ast) {
      return recur2(projected, ownedReference);
    }
    const referenceIdentifier = ownedReference === void 0 ? resolveReferenceIdentifier(ast) : void 0;
    if (referenceIdentifier !== void 0) {
      const reference2 = getReference(referenceIdentifier, ast);
      referenceMap.set(ast, reference2);
      if (!Object.hasOwn(references, reference2) && !externalReferences.has(reference2)) {
        assignProperty(references, reference2, on(ast));
      }
      return {
        _tag: "Reference",
        $ref: reference2
      };
    }
    if (ownedReference === void 0 && shared.has(ast)) {
      const reference2 = generateReference(`${ast._tag}_`, ast);
      referenceMap.set(ast, reference2);
      assignProperty(references, reference2, on(ast));
      return {
        _tag: "Reference",
        $ref: reference2
      };
    }
    if (visiting.has(ast)) {
      const reference2 = generateReference(`${ast._tag}_`, ast);
      referenceMap.set(ast, reference2);
      return {
        _tag: "Reference",
        $ref: reference2
      };
    }
    visiting.add(ast);
    const representation = on(ast);
    visiting.delete(ast);
    const reference = referenceMap.get(ast);
    if (reference !== void 0 && reference !== ownedReference) {
      assignProperty(references, reference, representation);
      return {
        _tag: "Reference",
        $ref: reference
      };
    }
    return representation;
  }
  function getReference(referenceIdentifier, ast) {
    if (!referenceIdentifier.isFallback) {
      return referenceIdentifier.identifier;
    }
    for (const [owner, reference2] of fallbackReferences) {
      if (hasSameReferenceOwner(owner, ast)) return reference2;
    }
    const reference = generateReference(referenceIdentifier.identifier, ast);
    fallbackReferences.push([ast, reference]);
    return reference;
  }
  function on(ast) {
    const checks = fromChecks(ast.checks);
    switch (ast._tag) {
      case "Declaration":
        return {
          _tag: "Declaration",
          typeParameters: ast.typeParameters.map((ast2) => recur2(ast2)),
          checks,
          ...fromDeclarationAnnotations(ast.annotations)
        };
      case "Null":
      case "Undefined":
      case "Void":
      case "Never":
      case "Unknown":
      case "Any":
      case "String":
      case "Boolean":
      case "Number":
      case "BigInt":
      case "Symbol":
      case "ObjectKeyword":
        return {
          _tag: ast._tag,
          checks,
          ...annotationsField(ast.annotations)
        };
      case "Literal":
        return {
          _tag: "Literal",
          literal: ast.literal,
          checks,
          ...annotationsField(ast.annotations)
        };
      case "UniqueSymbol":
        return {
          _tag: "UniqueSymbol",
          symbol: ast.symbol,
          checks,
          ...annotationsField(ast.annotations)
        };
      case "Enum":
        return {
          _tag: "Enum",
          enums: ast.enums,
          checks,
          ...annotationsField(ast.annotations)
        };
      case "TemplateLiteral":
        return {
          _tag: "TemplateLiteral",
          parts: ast.parts.map((ast2) => recur2(ast2)),
          checks,
          ...annotationsField(ast.annotations)
        };
      case "Arrays":
        return {
          _tag: "Arrays",
          elements: ast.elements.map((element) => {
            const projected = getLastEncoding(element);
            const annotations = projected.context?.annotations;
            return {
              isOptional: isOptional(projected),
              type: recur2(element),
              ...annotationsField(annotations)
            };
          }),
          rest: ast.rest.map((ast2) => recur2(ast2)),
          checks,
          ...annotationsField(ast.annotations)
        };
      case "Objects":
        return {
          _tag: "Objects",
          propertySignatures: ast.propertySignatures.map((property) => {
            const projected = getLastEncoding(property.type);
            const annotations = projected.context?.annotations;
            return {
              name: property.name,
              type: recur2(property.type),
              isOptional: isOptional(projected),
              isMutable: isMutable(projected),
              ...annotationsField(annotations)
            };
          }),
          indexSignatures: ast.indexSignatures.map((index) => ({
            parameter: recur2(index.parameter),
            type: recur2(index.type)
          })),
          checks,
          ...annotationsField(ast.annotations)
        };
      case "Union":
        return {
          _tag: "Union",
          types: ast.types.map((ast2) => recur2(ast2)),
          mode: ast.mode,
          checks,
          ...annotationsField(ast.annotations)
        };
      case "Suspend":
        return {
          _tag: "Suspend",
          checks: [],
          thunk: recur2(ast.thunk()),
          ...annotationsField(ast.annotations)
        };
    }
  }
  function fromChecks(checks) {
    return checks?.map(fromCheck) ?? [];
  }
  function fromCheck(check) {
    switch (check._tag) {
      case "Filter":
        return {
          _tag: "Filter",
          aborted: check.aborted,
          ...fromCheckAnnotations(check.annotations)
        };
      case "FilterGroup":
        return {
          _tag: "FilterGroup",
          checks: map2(check.checks, fromCheck),
          ...fromCheckAnnotations(check.annotations)
        };
    }
  }
  function fromDeclarationAnnotations(annotations) {
    if (annotations === void 0) return void 0;
    const {
      representation,
      ...ordinary
    } = annotations;
    return {
      ...representation === void 0 ? void 0 : {
        representation
      },
      ...Object.keys(ordinary).length === 0 ? void 0 : {
        annotations: ordinary
      }
    };
  }
  function fromCheckAnnotations(annotations) {
    if (annotations === void 0) return void 0;
    const {
      representation,
      ...ordinary
    } = annotations;
    const projected = representation === void 0 ? void 0 : representation.schemas === void 0 ? representation : {
      ...representation,
      schemas: representation.schemas.map((schema) => recur2(toType(schema)))
    };
    return {
      ...projected === void 0 ? void 0 : {
        representation: projected
      },
      ...Object.keys(ordinary).length === 0 ? void 0 : {
        annotations: ordinary
      }
    };
  }
}

// ../../node_modules/.pnpm/effect@4.0.0-beta.102/node_modules/effect/dist/Schema.js
function declareConstructor() {
  return (typeParameters, run2, annotations) => {
    return make7(new Declaration(typeParameters.map(getAST), (typeParameters2) => run2(typeParameters2.map((ast) => make7(ast))), annotations));
  };
}
function declare(is2, annotations) {
  return declareConstructor()([], () => (input, ast) => is2(input) ? succeed4(input) : fail5(new InvalidType(ast, some2(input))), annotations);
}
function decodeUnknownEffect2(schema, options) {
  const parser = decodeUnknownEffect(schema, options);
  return (input, options2) => {
    return fromIssueEffect(parser(input, options2));
  };
}
function getSchemaErrorOrThrow(cause, message) {
  let schemaError;
  for (const reason of cause.reasons) {
    if (!isFailReason2(reason) || !isSchemaError(reason.error)) {
      throw new globalThis.Error(message, {
        cause
      });
    }
    schemaError ??= reason.error;
  }
  if (schemaError === void 0) {
    throw new globalThis.Error(message, {
      cause
    });
  }
  return schemaError;
}
function runSchemaErrorPromise(self) {
  return runPromiseExit2(self).then((exit3) => {
    if (isSuccess3(exit3)) {
      return exit3.value;
    }
    throw getSchemaErrorOrThrow(exit3.cause, "Promise adapter can only reject schema errors");
  });
}
function decodeUnknownPromise(schema, options) {
  const parser = decodeUnknownEffect2(schema, options);
  return (input, options2) => {
    return runSchemaErrorPromise(parser(input, options2));
  };
}
var make7 = make6;
var optionalKey2 = /* @__PURE__ */ lambda((schema) => make7(optionalKey(schema.ast), {
  schema
}));
function Literal2(literal) {
  const out = make7(new Literal(literal), {
    literal,
    transform(to) {
      return out.pipe(decodeTo2(Literal2(to), {
        decode: transform(() => to),
        encode: transform(() => literal)
      }));
    }
  });
  return out;
}
var Never2 = /* @__PURE__ */ make7(never2);
var Unknown2 = /* @__PURE__ */ make7(unknown);
var Null2 = /* @__PURE__ */ make7(null_);
var String4 = /* @__PURE__ */ make7(string2);
var Number5 = /* @__PURE__ */ make7(number2);
var Boolean3 = /* @__PURE__ */ make7(boolean);
function makeStruct(ast, fields) {
  return make7(ast, {
    fields,
    mapFields(f, options) {
      const fields2 = f(this.fields);
      return makeStruct(struct(fields2, options?.unsafePreserveChecks ? this.ast.checks : void 0), fields2);
    }
  });
}
function Struct(fields) {
  return makeStruct(struct(fields, void 0), fields);
}
function Record(key, value, options) {
  const keyValueCombiner = options?.keyValueCombiner?.decode || options?.keyValueCombiner?.encode ? new KeyValueCombiner(options.keyValueCombiner.decode, options.keyValueCombiner.encode) : void 0;
  return make7(record(key.ast, value.ast, keyValueCombiner), {
    key,
    value
  });
}
function makeTuple(ast, elements) {
  return make7(ast, {
    elements,
    mapElements(f, options) {
      const elements2 = f(this.elements);
      return makeTuple(tuple(elements2, options?.unsafePreserveChecks ? this.ast.checks : void 0), elements2);
    }
  });
}
function Tuple(elements) {
  return makeTuple(tuple(elements), elements);
}
var ArraySchema = /* @__PURE__ */ lambda((schema) => make7(new Arrays(false, [], [schema.ast]), {
  value: schema
}));
function makeUnion(ast, members) {
  return make7(ast, {
    members,
    mapMembers(f, options) {
      const members2 = f(this.members);
      return makeUnion(union2(members2, this.ast.mode, options?.unsafePreserveChecks ? this.ast.checks : void 0), members2);
    }
  });
}
function Union2(members, options) {
  return makeUnion(union2(members, options?.mode ?? "anyOf", void 0), members);
}
function Literals(literals) {
  const members = literals.map(Literal2);
  return make7(union2(members, "anyOf", void 0), {
    literals,
    members,
    mapMembers(f) {
      return Union2(f(this.members));
    },
    pick(literals2) {
      return Literals(literals2);
    },
    transform(to) {
      return Union2(members.map((member, index) => member.transform(to[index])));
    }
  });
}
function decodeTo2(to, transformation) {
  return (from) => {
    return make7(decodeTo(from.ast, to.ast, transformation ? make4(transformation) : passthrough2()), {
      from,
      to
    });
  };
}
function withConstructorDefault2(defaultValue) {
  return (schema) => make7(withConstructorDefault(schema.ast, toIssueEffect(defaultValue)), {
    schema
  });
}
function toIssueEffect(self) {
  return catchCause2(self, (cause) => failCauseSync2(() => map4(cause, (error) => error.issue)));
}
function tag(literal) {
  return Literal2(literal).pipe(withConstructorDefault2(succeed4(literal)));
}
function instanceOf(constructor, annotations) {
  return declare((u) => u instanceof constructor, annotations);
}
function link() {
  return (encodeTo, transformation) => {
    return new Link(encodeTo.ast, make4(transformation));
  };
}
var makeFilter2 = makeFilter;
function isPattern2(regExp, annotations) {
  const source = regExp.source;
  const flags = regExp.flags;
  const runtimeRegExp = flags === "" ? `new RegExp(${format(source)})` : `new RegExp(${format(source)}, ${format(flags)})`;
  return isPattern(regExp, {
    toCode: () => ({
      runtime: `Schema.isPattern(${runtimeRegExp})`
    }),
    ...annotations
  });
}
function isBase64(annotations) {
  const regExp = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
  return isPattern2(regExp, {
    expected: "a base64 encoded string",
    representation: {
      id: "effect/schema/isBase64",
      payload: null
    },
    toJsonSchema: () => ({
      pattern: regExp.source
    }),
    toCode: () => ({
      runtime: "Schema.isBase64()"
    }),
    ...annotations
  });
}
var Finite = /* @__PURE__ */ make7(finite);
function makeIsBetween(deriveOptions) {
  const greaterThanOrEqualTo = isGreaterThanOrEqualTo(deriveOptions.order);
  const greaterThan = isGreaterThan(deriveOptions.order);
  const lessThanOrEqualTo = isLessThanOrEqualTo(deriveOptions.order);
  const lessThan = isLessThan(deriveOptions.order);
  const formatter = deriveOptions.formatter ?? format;
  return (options, annotations) => {
    const gte = options.exclusiveMinimum ? greaterThan : greaterThanOrEqualTo;
    const lte = options.exclusiveMaximum ? lessThan : lessThanOrEqualTo;
    return makeFilter2((input) => gte(input, options.minimum) && lte(input, options.maximum), {
      expected: `a value between ${formatter(options.minimum)}${options.exclusiveMinimum ? " (excluded)" : ""} and ${formatter(options.maximum)}${options.exclusiveMaximum ? " (excluded)" : ""}`,
      arbitrary: {
        constraint: {
          ordered: {
            order: deriveOptions.order,
            minimum: options.minimum,
            maximum: options.maximum,
            ...options.exclusiveMinimum && {
              exclusiveMinimum: true
            },
            ...options.exclusiveMaximum && {
              exclusiveMaximum: true
            }
          }
        }
      },
      ...deriveOptions.annotate?.(options),
      ...annotations
    });
  };
}
function encodeNumberPayload(number3) {
  if (!globalThis.Number.isFinite(number3)) {
    throw new globalThis.RangeError(`Expected a finite number, got ${format(number3)}`);
  }
  return number3;
}
var isBetween = /* @__PURE__ */ makeIsBetween({
  order: Number2,
  annotate: (options) => {
    const exclusiveMinimum = options.exclusiveMinimum ? true : void 0;
    const exclusiveMaximum = options.exclusiveMaximum ? true : void 0;
    const payload = {
      minimum: encodeNumberPayload(options.minimum),
      maximum: encodeNumberPayload(options.maximum),
      ...exclusiveMinimum && {
        exclusiveMinimum
      },
      ...exclusiveMaximum && {
        exclusiveMaximum
      }
    };
    return {
      representation: {
        id: "effect/schema/isBetween",
        payload
      },
      toJsonSchema: () => ({
        [exclusiveMinimum ? "exclusiveMinimum" : "minimum"]: options.minimum,
        [exclusiveMaximum ? "exclusiveMaximum" : "maximum"]: options.maximum
      }),
      toCode: () => ({
        runtime: `Schema.isBetween({ minimum: ${format(options.minimum)}, maximum: ${format(options.maximum)}, exclusiveMinimum: ${format(exclusiveMinimum)}, exclusiveMaximum: ${format(exclusiveMaximum)} })`
      })
    };
  }
});
function isInt(annotations) {
  return makeFilter2((n) => globalThis.Number.isSafeInteger(n), {
    expected: "an integer",
    representation: {
      id: "effect/schema/isInt",
      payload: null
    },
    toJsonSchema: () => ({
      type: "integer"
    }),
    toCode: () => ({
      runtime: "Schema.isInt()"
    }),
    arbitrary: {
      constraint: {
        integer: true
      }
    },
    ...annotations
  });
}
var Int = /* @__PURE__ */ Number5.check(/* @__PURE__ */ isInt());
function isMinLength(minLength, annotations) {
  minLength = Math.max(0, Math.floor(minLength));
  return makeFilter2((input) => input.length >= minLength, {
    expected: `a value with a length of at least ${minLength}`,
    representation: {
      id: "effect/schema/isMinLength",
      payload: {
        minLength
      }
    },
    toJsonSchema: ({
      type
    }) => type === "array" ? {
      minItems: minLength
    } : {
      minLength
    },
    toCode: () => ({
      runtime: `Schema.isMinLength(${minLength})`
    }),
    [STRUCTURAL_ANNOTATION_KEY]: true,
    arbitrary: {
      constraint: {
        minLength
      }
    },
    ...annotations
  });
}
function isMaxLength(maxLength, annotations) {
  maxLength = Math.max(0, Math.floor(maxLength));
  return makeFilter2((input) => input.length <= maxLength, {
    expected: `a value with a length of at most ${maxLength}`,
    representation: {
      id: "effect/schema/isMaxLength",
      payload: {
        maxLength
      }
    },
    toJsonSchema: ({
      type
    }) => type === "array" ? {
      maxItems: maxLength
    } : {
      maxLength
    },
    toCode: () => ({
      runtime: `Schema.isMaxLength(${maxLength})`
    }),
    [STRUCTURAL_ANNOTATION_KEY]: true,
    arbitrary: {
      constraint: {
        maxLength
      }
    },
    ...annotations
  });
}
var RegExp3 = /* @__PURE__ */ instanceOf(globalThis.RegExp, {
  representation: {
    id: "effect/schema/RegExp",
    payload: null
  },
  toCode: () => ({
    runtime: `Schema.RegExp`,
    Type: `globalThis.RegExp`
  }),
  expected: "RegExp",
  toCodecJson: () => link()(Struct({
    source: String4,
    flags: String4
  }), transformOrFail2({
    decode: (e) => try_2({
      try: () => new globalThis.RegExp(e.source, e.flags),
      catch: (e2) => new InvalidValue(some2(e2), {
        message: globalThis.String(e2)
      })
    }),
    encode: (regExp) => succeed4({
      source: regExp.source,
      flags: regExp.flags
    })
  })),
  toArbitrary: () => (fc) => fc.tuple(fc.constantFrom(
    ".",
    ".*",
    "\\d+",
    "\\w+",
    "[a-z]+",
    "[A-Z]+",
    "[0-9]+",
    "^[a-zA-Z0-9]+$",
    "^\\d{4}-\\d{2}-\\d{2}$"
    // date pattern
  ), fc.uniqueArray(fc.constantFrom("g", "i", "m", "s", "u", "y"), {
    minLength: 0,
    maxLength: 6
  }).map((flags) => flags.join(""))).map(([source, flags]) => new globalThis.RegExp(source, flags)),
  toEquivalence: () => (a, b) => a.source === b.source && a.flags === b.flags
});
var URLString = /* @__PURE__ */ String4.annotate({
  expected: "a string that will be decoded as a URL"
});
var URL2 = /* @__PURE__ */ instanceOf(globalThis.URL, {
  representation: {
    id: "effect/schema/URL",
    payload: null
  },
  toCode: () => ({
    runtime: `Schema.URL`,
    Type: `globalThis.URL`
  }),
  expected: "URL",
  toCodecJson: () => link()(URLString, urlFromString),
  toArbitrary: () => (fc) => fc.webUrl().map((s) => new globalThis.URL(s)),
  toEquivalence: () => (a, b) => a.toString() === b.toString()
});
var File = /* @__PURE__ */ instanceOf(globalThis.File, {
  representation: {
    id: "effect/schema/File",
    payload: null
  },
  toCode: () => ({
    runtime: `Schema.File`,
    Type: `globalThis.File`
  }),
  expected: "File",
  toCodecJson: () => link()(Struct({
    data: String4.check(isBase64()),
    type: String4,
    name: String4,
    lastModified: Int
  }), transformOrFail2({
    decode: (e) => match(decodeBase64(e.data), {
      onFailure: (error) => fail5(new InvalidValue(some2(e.data), {
        message: error.message
      })),
      onSuccess: (bytes) => {
        const buffer = new globalThis.Uint8Array(bytes);
        return succeed4(new globalThis.File([buffer], e.name, {
          type: e.type,
          lastModified: e.lastModified
        }));
      }
    }),
    encode: (file) => tryPromise2({
      try: async () => {
        const bytes = new globalThis.Uint8Array(await file.arrayBuffer());
        return {
          data: encodeBase64(bytes),
          type: file.type,
          name: file.name,
          lastModified: file.lastModified
        };
      },
      catch: (e) => new InvalidValue(some2(file), {
        message: globalThis.String(e)
      })
    })
  }))
});
var FormData2 = /* @__PURE__ */ instanceOf(globalThis.FormData, {
  representation: {
    id: "effect/schema/FormData",
    payload: null
  },
  toCode: () => ({
    runtime: `Schema.FormData`,
    Type: `globalThis.FormData`
  }),
  expected: "FormData",
  toCodecJson: () => link()(ArraySchema(Tuple([String4, Union2([Struct({
    _tag: tag("String"),
    value: String4
  }), Struct({
    _tag: tag("File"),
    value: File
  })])])), transformOrFail2({
    decode: (e) => {
      const out = new globalThis.FormData();
      for (const [key, entry] of e) {
        out.append(key, entry.value);
      }
      return succeed4(out);
    },
    encode: (formData) => {
      return succeed4(globalThis.Array.from(formData.entries()).map(([key, value]) => {
        if (typeof value === "string") {
          return [key, {
            _tag: "String",
            value
          }];
        } else {
          return [key, {
            _tag: "File",
            value
          }];
        }
      }));
    }
  }))
});
var URLSearchParams2 = /* @__PURE__ */ instanceOf(globalThis.URLSearchParams, {
  representation: {
    id: "effect/schema/URLSearchParams",
    payload: null
  },
  toCode: () => ({
    runtime: `Schema.URLSearchParams`,
    Type: `globalThis.URLSearchParams`
  }),
  expected: "URLSearchParams",
  toCodecJson: () => link()(String4.annotate({
    expected: "a query string that will be decoded as URLSearchParams"
  }), transform2({
    decode: (e) => new globalThis.URLSearchParams(e),
    encode: (params) => params.toString()
  }))
});
var Base64String = /* @__PURE__ */ String4.annotate({
  expected: "a base64 encoded string that will be decoded as Uint8Array",
  format: "byte",
  contentEncoding: "base64"
});
var Uint8Array2 = /* @__PURE__ */ instanceOf(globalThis.Uint8Array, {
  representation: {
    id: "effect/schema/Uint8Array",
    payload: null
  },
  toCode: () => ({
    runtime: `Schema.Uint8Array`,
    Type: `globalThis.Uint8Array`
  }),
  expected: "Uint8Array",
  toCodecJson: () => link()(Base64String, uint8ArrayFromBase64String),
  toArbitrary: () => (fc) => fc.uint8Array()
});
function toJsonSchemaDocument2(schema, options) {
  const document = toRepresentation(toCodecJsonAST(schema.ast));
  return toJsonSchemaDocument(document, options);
}
var toCodecJsonASTBase = /* @__PURE__ */ applyToSelfOrLastLinkEncoding((ast) => {
  const out = toCodecJsonBase(ast, toCodecJsonAST);
  const context2 = ast.context;
  if (out === ast || context2 === void 0) return out;
  return replaceContextLastLink(out, withoutConstructorDefault(context2));
});
var toCodecJsonAST = /* @__PURE__ */ memoize((ast) => {
  const identifier2 = resolveIdentifier(ast);
  const out = toCodecJsonASTBase(ast);
  if (identifier2 === void 0 || out.encoding === void 0) return out;
  const encoded = getLastEncoding(out);
  if (resolveIdentifier(encoded) !== void 0 || resolveIdentifierFallback(encoded) === identifier2) {
    return out;
  }
  const annotated = annotate(encoded, {
    [IDENTIFIER_FALLBACK_KEY]: identifier2
  });
  return applyToSelfOrLastLinkEncoding(() => annotated)(out);
});
function withoutConstructorDefault(context2) {
  return context2.defaultValue === void 0 ? context2 : new Context(context2.isOptional, context2.isMutable, void 0, context2.annotations);
}
function validateCanonicalObjectPropertyNames(ast) {
  if (ast.propertySignatures.some((ps) => typeof ps.name !== "string")) {
    throw new globalThis.Error("Objects property names must be strings", {
      cause: ast
    });
  }
}
function makeReorder(getPriority) {
  return (types) => {
    const indexMap = /* @__PURE__ */ new Map();
    for (let i = 0; i < types.length; i++) {
      indexMap.set(toEncoded(types[i]), i);
    }
    const sortedTypes = [...types].sort((a, b) => {
      a = toEncoded(a);
      b = toEncoded(b);
      const pa = getPriority(a);
      const pb = getPriority(b);
      if (pa !== pb) return pa - pb;
      return indexMap.get(a) - indexMap.get(b);
    });
    const orderChanged = sortedTypes.some((ast, index) => ast !== types[index]);
    if (!orderChanged) return types;
    return sortedTypes;
  };
}
var toCodecJsonReorder = /* @__PURE__ */ makeReorder((ast) => {
  switch (ast._tag) {
    case "BigInt":
    case "Symbol":
    case "UniqueSymbol":
      return 0;
    default:
      return 1;
  }
});
function toCodecJsonBase(ast, recur2) {
  switch (ast._tag) {
    case "Declaration": {
      const getLink = ast.annotations?.toCodecJson ?? ast.annotations?.toCodec;
      if (!isFunction(getLink)) {
        return replaceEncoding(ast, [unknownToJson]);
      }
      const typeParameters = ast.typeParameters.map((tp) => make6(toEncoded(tp)));
      const link2 = getLink(typeParameters);
      return link2 === void 0 ? ast : replaceEncoding(ast, [mapLink(link2, recur2)]);
    }
    case "Unknown":
      return replaceEncoding(ast, [unknownToJson]);
    case "ObjectKeyword":
      return replaceEncoding(ast, [objectKeywordToJson]);
    case "Undefined":
    case "Void":
    case "Literal":
    case "Number":
      return ast.toCodecJson();
    case "UniqueSymbol":
    case "Symbol":
    case "BigInt":
      return ast.toCodecStringTree();
    case "Objects": {
      validateCanonicalObjectPropertyNames(ast);
      return ast.recur(recur2, parameterFromString);
    }
    case "Union": {
      const sortedTypes = toCodecJsonReorder(ast.types);
      if (sortedTypes !== ast.types) {
        return new Union(sortedTypes, ast.mode, ast.annotations, ast.checks, ast.encoding, ast.context, ast.encodingChecks).recur(recur2);
      }
      return ast.recur(recur2);
    }
    case "Arrays":
    case "Suspend":
      return ast.recur(recur2);
  }
  return ast;
}

// src/N8nProvider.ts
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeUtil from "node:util";

// src/host-contract.ts
var IntegrationProviderPublicError = class extends Error {
  _tag = "PluginFailure";
  code = "n8n_operation_failed";
  retryable = false;
  constructor(message) {
    super(message.trim() || "n8n operation failed.");
    this.name = "PluginFailure";
  }
};
var ExternalCommitOutcomeUnknownError = class extends Error {
  _tag = "ExternalCommitOutcomeUnknown";
  code = "external_commit_outcome_unknown";
  retryable = false;
  constructor(message = "The external commit may have completed. Do not retry automatically.") {
    super(message);
    this.name = "ExternalCommitOutcomeUnknown";
  }
};

// src/N8nProvider.ts
var N8N_PROVIDER_ID = "n8n";
var N8N_SECRET_SUFFIX = "oauth";
var REVIEWED_SERVER_URL = "https://n8n.tritonai.ucsd.edu/mcp-server/http";
var CALLBACK_PATH = "/oauth2/callback";
var MCP_PROTOCOL_VERSION = "2026-07-28";
var MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
var MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
var MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
var MCP_CLIENT_INFO = { name: "TritonAI Harness", version: "1.0.0" };
var DEFAULT_REQUEST_TIMEOUT_MS = 2e4;
var TEST_REQUEST_TIMEOUT_MS = 5 * 6e4 + 1e4;
var FLOW_LIFETIME_MS = 5 * 6e4;
var FLOW_CALLBACK_CLAIM_MS = 6e4;
var FLOW_POLL_SECONDS = 2;
var ACCESS_TOKEN_SKEW_MS = 6e4;
var METADATA_RESPONSE_BYTES = 128 * 1024;
var TOKEN_RESPONSE_BYTES = 128 * 1024;
var MCP_CONTROL_RESPONSE_BYTES = 2 * 1024 * 1024;
var MCP_TOOL_RESPONSE_BYTES = 8 * 1024 * 1024;
var MAX_TOKEN_CHARS = 16384;
var MAX_CLIENT_ID_CHARS = 1024;
var MAX_SESSION_ID_CHARS = 1024;
var MAX_INPUT_BYTES = 2 * 1024 * 1024;
var MAX_JSON_DEPTH = 32;
var MAX_JSON_NODES = 1e5;
var MAX_MCP_PAGES = 4;
var MAX_MCP_TOOLS = 64;
var encoder2 = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var READ_OAUTH_SCOPES = [
  "credential:read",
  "dataTable:read",
  "execution:read",
  "project:read",
  "tag:read",
  "workflow:read"
];
var WRITE_OAUTH_SCOPES = [
  "dataTable:write",
  "project:write",
  "workflow:execute",
  "workflow:write"
];
var OAUTH_SCOPES = [...READ_OAUTH_SCOPES, ...WRITE_OAUTH_SCOPES];
var OAUTH_SCOPE_SET = new Set(OAUTH_SCOPES);
var CAPABILITIES = ["read", "write"];
var CAPABILITY_SET = new Set(CAPABILITIES);
var BoundedId = String4.check(
  isMinLength(1),
  isMaxLength(1024),
  isPattern2(/^[^\p{Cc}\s]+$/u)
);
var BoundedText = String4.check(isMinLength(1), isMaxLength(512));
var Code = String4.check(isMinLength(1), isMaxLength(1e6));
var OptionalQuery = optionalKey2(
  String4.check(isMinLength(1), isMaxLength(512))
);
var OptionalProjectId = optionalKey2(BoundedId);
var OptionalFolderId = optionalKey2(
  String4.check(
    isMinLength(1),
    isMaxLength(36),
    isPattern2(/^[A-Za-z0-9_-]+$/u)
  )
);
var OptionalLimit100 = optionalKey2(
  Int.check(isBetween({ minimum: 1, maximum: 100 }))
);
var OptionalLimit200 = optionalKey2(
  Int.check(isBetween({ minimum: 1, maximum: 200 }))
);
var JsonObject = Record(
  String4.check(isMinLength(1), isMaxLength(256)),
  Unknown2
);
var EmptyInput = Record(String4, Never2);
var SearchWorkflowsInput = Struct({
  query: OptionalQuery,
  projectId: OptionalProjectId,
  tags: optionalKey2(
    ArraySchema(BoundedText).check(isMinLength(1), isMaxLength(50))
  ),
  limit: OptionalLimit200,
  sortBy: optionalKey2(
    Literals([
      "updatedAt:desc",
      "updatedAt:asc",
      "createdAt:desc",
      "createdAt:asc",
      "name:asc",
      "name:desc"
    ])
  ),
  folderId: OptionalFolderId,
  includeSubfolders: optionalKey2(Boolean3)
});
var WorkflowIdInput = Struct({ workflowId: BoundedId });
var WorkflowDetailsInput = Struct({
  workflowId: BoundedId,
  detailLevel: optionalKey2(Literals(["full", "execution"]))
});
var WorkflowHistoryInput = Struct({
  workflowId: BoundedId,
  limit: optionalKey2(Int.check(isBetween({ minimum: 1, maximum: 50 }))),
  offset: optionalKey2(Int.check(isBetween({ minimum: 0, maximum: 1e5 })))
});
var WorkflowVersionInput = Struct({ workflowId: BoundedId, versionId: BoundedId });
var ExecuteWorkflowInput = Struct({
  workflowId: BoundedId,
  executionMode: Literals(["manual", "production"]),
  triggerNodeName: optionalKey2(BoundedText),
  inputs: optionalKey2(
    Union2([
      Struct({ chatInput: BoundedText }),
      Struct({ formData: JsonObject }),
      Struct({
        webhookData: Struct({
          method: optionalKey2(
            Literals(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
          ),
          query: optionalKey2(Record(BoundedText, String4)),
          body: optionalKey2(JsonObject),
          headers: optionalKey2(Record(BoundedText, String4))
        })
      })
    ])
  )
});
var TestWorkflowInput = Struct({
  workflowId: BoundedId,
  pinData: Record(BoundedText, ArraySchema(JsonObject).check(isMaxLength(1e3))),
  triggerNodeName: optionalKey2(BoundedText),
  timeout: optionalKey2(Int.check(isBetween({ minimum: 1, maximum: 3600 })))
});
var PublishWorkflowInput = Struct({
  workflowId: BoundedId,
  versionId: optionalKey2(BoundedId)
});
var SearchProjectsInput = Struct({
  query: OptionalQuery,
  type: optionalKey2(Literals(["personal", "team"])),
  limit: OptionalLimit100
});
var SearchFoldersInput = Struct({
  projectId: BoundedId,
  query: OptionalQuery,
  limit: OptionalLimit100
});
var ListTagsInput = Struct({
  limit: optionalKey2(Int.check(isBetween({ minimum: 1, maximum: 500 })))
});
var GetExecutionInput = Struct({
  workflowId: BoundedId,
  executionId: BoundedId,
  includeData: optionalKey2(Boolean3),
  nodeNames: optionalKey2(
    ArraySchema(BoundedText).check(isMinLength(1), isMaxLength(100))
  ),
  truncateData: optionalKey2(
    Int.check(isBetween({ minimum: 1, maximum: 1e4 }))
  )
});
var SearchExecutionsInput = Struct({
  workflowId: optionalKey2(BoundedId),
  status: optionalKey2(
    ArraySchema(
      Literals([
        "canceled",
        "crashed",
        "error",
        "new",
        "running",
        "success",
        "unknown",
        "waiting"
      ])
    ).check(isMinLength(1), isMaxLength(8))
  ),
  startedAfter: optionalKey2(
    String4.check(isMinLength(20), isMaxLength(64))
  ),
  startedBefore: optionalKey2(
    String4.check(isMinLength(20), isMaxLength(64))
  ),
  limit: OptionalLimit200,
  lastId: optionalKey2(BoundedId)
});
var ListCredentialsInput = Struct({
  limit: OptionalLimit200,
  query: OptionalQuery,
  type: optionalKey2(BoundedText),
  projectId: OptionalProjectId,
  onlySharedWithMe: optionalKey2(Boolean3)
});
var GetSdkReferenceInput = Struct({
  section: optionalKey2(
    Literals([
      "patterns",
      "patterns_detailed",
      "expressions",
      "functions",
      "rules",
      "import",
      "guidelines",
      "design",
      "all",
      "groups"
    ])
  )
});
var SearchNodesInput = Struct({
  queries: ArraySchema(BoundedText).check(isMinLength(1), isMaxLength(50)),
  usage: optionalKey2(Literals(["workflow", "agentTool"]))
});
var NodeTypeRequest = Struct({
  nodeId: BoundedText,
  version: optionalKey2(BoundedText),
  resource: optionalKey2(BoundedText),
  operation: optionalKey2(BoundedText),
  mode: optionalKey2(BoundedText)
});
var GetNodeTypesInput = Struct({
  nodeIds: ArraySchema(NodeTypeRequest).check(isMinLength(1), isMaxLength(50))
});
var BestPracticesInput = Struct({
  technique: Union2([
    Literals([
      "scheduling",
      "chatbot",
      "form_input",
      "scraping_and_research",
      "monitoring",
      "enrichment",
      "triage",
      "content_generation",
      "document_processing",
      "data_extraction",
      "data_analysis",
      "data_transformation",
      "data_persistence",
      "notification",
      "knowledge_base",
      "human_in_the_loop",
      "web_app"
    ]),
    Literal2("list")
  ])
});
var ExploreNodeResourcesInput = Struct({
  nodeType: BoundedText,
  version: Finite.check(isBetween({ minimum: 0, maximum: 1e4 })),
  methodName: BoundedText,
  methodType: Literals(["listSearch", "loadOptions"]),
  credentialType: BoundedText,
  credentialId: BoundedId,
  filter: optionalKey2(String4.check(isMaxLength(512))),
  paginationToken: optionalKey2(BoundedId),
  currentNodeParameters: optionalKey2(JsonObject)
});
var ValidateWorkflowInput = Struct({ code: Code });
var NodeConfiguration = Struct({
  name: optionalKey2(BoundedText),
  type: BoundedText,
  typeVersion: optionalKey2(
    Finite.check(isBetween({ minimum: 0, maximum: 1e4 }))
  ),
  parameters: optionalKey2(JsonObject),
  subnodes: optionalKey2(Unknown2),
  isToolNode: optionalKey2(Boolean3)
});
var ValidateNodeConfigInput = Struct({
  nodes: ArraySchema(NodeConfiguration).check(isMinLength(1), isMaxLength(50))
});
var SkillsUsed = optionalKey2(ArraySchema(BoundedText).check(isMaxLength(100)));
var CreateWorkflowInput = Struct({
  code: Code,
  skillsUsed: SkillsUsed,
  name: optionalKey2(String4.check(isMinLength(1), isMaxLength(128))),
  description: optionalKey2(String4.check(isMaxLength(16384))),
  versionName: optionalKey2(
    String4.check(isMinLength(1), isMaxLength(80))
  ),
  versionDescription: optionalKey2(String4.check(isMaxLength(1e3))),
  projectId: OptionalProjectId,
  folderId: optionalKey2(BoundedId)
});
var PositionCoordinate = Finite.check(
  isBetween({ minimum: -1e6, maximum: 1e6 })
);
var NodePosition = ArraySchema(PositionCoordinate).check(
  isMinLength(2),
  isMaxLength(2)
);
var NodeCredentials = Record(
  BoundedText,
  Struct({ id: optionalKey2(BoundedId), name: BoundedText })
);
var NewNode = Struct({
  id: optionalKey2(BoundedId),
  name: BoundedText,
  type: BoundedText,
  typeVersion: Finite.check(isBetween({ minimum: 0, maximum: 1e4 })),
  parameters: optionalKey2(JsonObject),
  position: optionalKey2(NodePosition),
  credentials: optionalKey2(NodeCredentials),
  disabled: optionalKey2(Boolean3),
  notes: optionalKey2(String4.check(isMaxLength(16384)))
});
var ConnectionFields = {
  source: BoundedText,
  target: BoundedText,
  sourceIndex: optionalKey2(
    Int.check(isBetween({ minimum: 0, maximum: 1e3 }))
  ),
  targetIndex: optionalKey2(
    Int.check(isBetween({ minimum: 0, maximum: 1e3 }))
  ),
  connectionType: optionalKey2(BoundedText)
};
var UpdateSettings = Struct({
  onError: optionalKey2(
    Literals(["stopWorkflow", "continueRegularOutput", "continueErrorOutput"])
  ),
  retryOnFail: optionalKey2(Boolean3),
  maxTries: optionalKey2(Int.check(isBetween({ minimum: 2, maximum: 5 }))),
  waitBetweenTries: optionalKey2(
    Int.check(isBetween({ minimum: 0, maximum: 5e3 }))
  ),
  alwaysOutputData: optionalKey2(Boolean3),
  executeOnce: optionalKey2(Boolean3),
  errorWorkflow: optionalKey2(BoundedId),
  timezone: optionalKey2(BoundedText),
  executionOrder: optionalKey2(Literals(["v0", "v1"])),
  saveExecutionProgress: optionalKey2(
    Union2([Boolean3, Literal2("DEFAULT")])
  ),
  saveManualExecutions: optionalKey2(
    Union2([Boolean3, Literal2("DEFAULT")])
  ),
  saveDataErrorExecution: optionalKey2(Literals(["DEFAULT", "all", "none"])),
  saveDataSuccessExecution: optionalKey2(Literals(["DEFAULT", "all", "none"])),
  executionTimeout: optionalKey2(
    Int.check(isBetween({ minimum: -1, maximum: 31536e3 }))
  ),
  timeSavedPerExecution: optionalKey2(
    Int.check(isBetween({ minimum: 0, maximum: 1e6 }))
  ),
  callerPolicy: optionalKey2(
    Literals(["any", "none", "workflowsFromAList", "workflowsFromSameOwner"])
  ),
  callerIds: optionalKey2(String4.check(isMaxLength(16384)))
});
var UpdateOperation = Struct({
  type: Literals([
    "updateNodeParameters",
    "setNodeParameter",
    "addNode",
    "removeNode",
    "renameNode",
    "addConnection",
    "removeConnection",
    "setNodeCredential",
    "setNodePosition",
    "setNodeDisabled",
    "setNodeSettings",
    "setWorkflowMetadata",
    "setWorkflowSettings",
    "addTags",
    "removeTags",
    "setNodeGroups",
    "addNodeGroup",
    "removeNodeGroup",
    "updateNodeGroup"
  ]),
  nodeName: optionalKey2(BoundedText),
  node: optionalKey2(NewNode),
  parameters: optionalKey2(JsonObject),
  replace: optionalKey2(Boolean3),
  path: optionalKey2(
    String4.check(isMinLength(2), isMaxLength(1024), isPattern2(/^\//u))
  ),
  value: optionalKey2(Unknown2),
  oldName: optionalKey2(BoundedText),
  newName: optionalKey2(BoundedText),
  source: optionalKey2(ConnectionFields.source),
  target: optionalKey2(ConnectionFields.target),
  sourceIndex: ConnectionFields.sourceIndex,
  targetIndex: ConnectionFields.targetIndex,
  connectionType: ConnectionFields.connectionType,
  credentialKey: optionalKey2(BoundedText),
  credentialId: optionalKey2(BoundedId),
  credentialName: optionalKey2(BoundedText),
  position: optionalKey2(NodePosition),
  disabled: optionalKey2(Boolean3),
  settings: optionalKey2(UpdateSettings),
  name: optionalKey2(String4.check(isMinLength(1), isMaxLength(128))),
  description: optionalKey2(String4.check(isMaxLength(255))),
  names: optionalKey2(
    ArraySchema(BoundedText).check(isMinLength(1), isMaxLength(100))
  ),
  nodeGroups: optionalKey2(
    ArraySchema(
      Struct({
        id: optionalKey2(BoundedId),
        name: BoundedText,
        nodeNames: ArraySchema(BoundedText).check(isMaxLength(250)),
        description: optionalKey2(String4.check(isMaxLength(1e3)))
      })
    ).check(isMaxLength(100))
  ),
  groupName: optionalKey2(BoundedText),
  nodeNames: optionalKey2(
    ArraySchema(BoundedText).check(isMinLength(1), isMaxLength(250))
  ),
  id: optionalKey2(BoundedId)
});
var UpdateWorkflowInput = Struct({
  workflowId: BoundedId,
  skillsUsed: SkillsUsed,
  versionName: optionalKey2(
    String4.check(isMinLength(1), isMaxLength(80))
  ),
  versionDescription: optionalKey2(String4.check(isMaxLength(1e3))),
  operations: ArraySchema(UpdateOperation).check(isMinLength(1), isMaxLength(100))
});
var SearchDataTablesInput = Struct({
  query: OptionalQuery,
  projectId: OptionalProjectId,
  limit: OptionalLimit100
});
var ColumnType = Literals(["string", "number", "boolean", "date"]);
var ColumnName = String4.check(
  isMinLength(1),
  isMaxLength(63),
  isPattern2(/^[A-Za-z][A-Za-z0-9_]*$/u)
);
var CreateDataTableInput = Struct({
  projectId: BoundedId,
  name: String4.check(isMinLength(1), isMaxLength(128)),
  columns: ArraySchema(Struct({ name: ColumnName, type: ColumnType })).check(
    isMinLength(1),
    isMaxLength(250)
  )
});
var DataTableIdentity = { dataTableId: BoundedId, projectId: BoundedId };
var AddDataTableColumnInput = Struct({
  ...DataTableIdentity,
  name: ColumnName,
  type: ColumnType
});
var RenameDataTableColumnInput = Struct({
  ...DataTableIdentity,
  columnId: BoundedId,
  name: ColumnName
});
var DeleteDataTableColumnInput = Struct({
  ...DataTableIdentity,
  columnId: BoundedId
});
var RenameDataTableInput = Struct({
  ...DataTableIdentity,
  name: String4.check(isMinLength(1), isMaxLength(128))
});
var DataTableScalar = Union2([String4, Finite, Boolean3, Null2]);
var AddDataTableRowsInput = Struct({
  ...DataTableIdentity,
  rows: ArraySchema(Record(ColumnName, DataTableScalar)).check(
    isMinLength(1),
    isMaxLength(1e3)
  )
});
function reviewedTool(upstreamName, description, input, capability, options = {}) {
  const readOnly = options.readOnly ?? true;
  return {
    name: `n8n.${upstreamName}`,
    upstreamName,
    description,
    input,
    capability,
    readOnly,
    destructive: options.destructive ?? false,
    idempotent: options.idempotent ?? readOnly,
    openWorld: options.openWorld ?? false
  };
}
var REVIEWED_TOOLS = [
  reviewedTool(
    "search_workflows",
    "Search workflow previews visible to the connected n8n user.",
    SearchWorkflowsInput,
    "read"
  ),
  reviewedTool(
    "get_workflow_details",
    "Read one accessible workflow with sanitized nodes and trigger guidance.",
    WorkflowDetailsInput,
    "read"
  ),
  reviewedTool(
    "get_workflow_history",
    "Read bounded version history for one accessible workflow.",
    WorkflowHistoryInput,
    "read"
  ),
  reviewedTool(
    "get_workflow_version",
    "Read one exact historical workflow version.",
    WorkflowVersionInput,
    "read"
  ),
  reviewedTool(
    "execute_workflow",
    "Execute an accessible workflow in manual or production mode.",
    ExecuteWorkflowInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false, openWorld: true }
  ),
  reviewedTool(
    "test_workflow",
    "Test workflow logic with bounded pin data.",
    TestWorkflowInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false }
  ),
  reviewedTool(
    "prepare_workflow_pin_data",
    "Prepare pin-data schemas for testing one workflow.",
    WorkflowIdInput,
    "write"
  ),
  reviewedTool(
    "publish_workflow",
    "Publish an accessible workflow version.",
    PublishWorkflowInput,
    "write",
    { readOnly: false, idempotent: true }
  ),
  reviewedTool(
    "unpublish_workflow",
    "Unpublish an accessible workflow.",
    WorkflowIdInput,
    "write",
    { readOnly: false, idempotent: true }
  ),
  reviewedTool(
    "search_projects",
    "Search projects visible to the connected n8n user.",
    SearchProjectsInput,
    "read"
  ),
  reviewedTool(
    "search_folders",
    "Search folders within one accessible project.",
    SearchFoldersInput,
    "read"
  ),
  reviewedTool("list_workflow_tags", "List available workflow tags.", ListTagsInput, "read"),
  reviewedTool(
    "get_workflow_execution",
    "Read one accessible execution with optionally bounded result data.",
    GetExecutionInput,
    "read"
  ),
  reviewedTool(
    "search_workflow_executions",
    "Search accessible workflow executions.",
    SearchExecutionsInput,
    "read"
  ),
  reviewedTool(
    "list_credentials",
    "List accessible credential names and metadata without secret values.",
    ListCredentialsInput,
    "read"
  ),
  reviewedTool(
    "list_n8n_connect_services",
    "List n8n Connect managed-credential coverage without credential values.",
    EmptyInput,
    "read"
  ),
  reviewedTool(
    "get_workflow_sdk_reference",
    "Read reviewed n8n Workflow SDK reference material.",
    GetSdkReferenceInput,
    "read"
  ),
  reviewedTool(
    "search_nodes",
    "Search n8n node types by bounded queries.",
    SearchNodesInput,
    "read"
  ),
  reviewedTool(
    "get_node_types",
    "Read exact TypeScript definitions for selected n8n node types.",
    GetNodeTypesInput,
    "read"
  ),
  reviewedTool(
    "get_workflow_best_practices",
    "Read n8n best practices for a workflow technique.",
    BestPracticesInput,
    "read"
  ),
  reviewedTool(
    "explore_node_resources",
    "Resolve resources for one node using an accessible credential.",
    ExploreNodeResourcesInput,
    "read",
    { openWorld: true }
  ),
  reviewedTool(
    "validate_workflow",
    "Validate bounded Workflow SDK code without saving it.",
    ValidateWorkflowInput,
    "read"
  ),
  reviewedTool(
    "validate_node_config",
    "Validate bounded node configurations without saving them.",
    ValidateNodeConfigInput,
    "read"
  ),
  reviewedTool(
    "create_workflow_from_code",
    "Create a workflow from validated Workflow SDK code.",
    CreateWorkflowInput,
    "write",
    { readOnly: false, idempotent: false }
  ),
  reviewedTool(
    "update_workflow",
    "Atomically apply a bounded ordered operation batch to a workflow.",
    UpdateWorkflowInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false }
  ),
  reviewedTool("archive_workflow", "Archive an accessible workflow.", WorkflowIdInput, "write", {
    readOnly: false,
    destructive: true,
    idempotent: true
  }),
  reviewedTool(
    "restore_workflow_version",
    "Restore an accessible workflow from one exact historical version.",
    WorkflowVersionInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false }
  ),
  reviewedTool(
    "search_data_tables",
    "Search data tables visible to the connected n8n user.",
    SearchDataTablesInput,
    "read"
  ),
  reviewedTool(
    "create_data_table",
    "Create a data table in an accessible project.",
    CreateDataTableInput,
    "write",
    { readOnly: false, idempotent: false }
  ),
  reviewedTool(
    "add_data_table_column",
    "Add a column to an accessible data table.",
    AddDataTableColumnInput,
    "write",
    { readOnly: false, idempotent: false }
  ),
  reviewedTool(
    "rename_data_table_column",
    "Rename a column in an accessible data table.",
    RenameDataTableColumnInput,
    "write",
    { readOnly: false, idempotent: true }
  ),
  reviewedTool(
    "delete_data_table_column",
    "Permanently delete a data-table column and its data.",
    DeleteDataTableColumnInput,
    "write",
    { readOnly: false, destructive: true, idempotent: false }
  ),
  reviewedTool(
    "rename_data_table",
    "Rename an accessible data table.",
    RenameDataTableInput,
    "write",
    { readOnly: false, idempotent: true }
  ),
  reviewedTool(
    "add_data_table_rows",
    "Insert bounded rows into an accessible data table.",
    AddDataTableRowsInput,
    "write",
    { readOnly: false, idempotent: false }
  )
];
var N8N_TOOLS = REVIEWED_TOOLS;
function asRecord(value, label = "n8n response") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function boundedString(value, maximum, label = "n8n response") {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}
function exactStringSet(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.size || value.some((entry) => typeof entry !== "string" || !expected.has(entry)) || new Set(value).size !== value.length) {
    throw new Error(`${label} drifted from the reviewed contract.`);
  }
  return [...value].toSorted();
}
function validateServerUrl(value) {
  const normalized = value.trim();
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("n8n requires the reviewed HTTPS MCP server URL.");
  }
  if (url.toString() !== REVIEWED_SERVER_URL || url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.port !== "" || url.hostname !== "n8n.tritonai.ucsd.edu" || url.pathname !== "/mcp-server/http") {
    throw new Error("n8n requires the reviewed HTTPS MCP server URL.");
  }
  return url;
}
function sameOriginEndpoint(value, path, origin, label) {
  const raw = boundedString(value, 2048, label);
  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (endpoint.protocol !== "https:" || endpoint.origin !== origin || endpoint.pathname !== path || endpoint.search !== "" || endpoint.hash !== "" || endpoint.username !== "" || endpoint.password !== "") {
    throw new Error(`${label} is outside the reviewed n8n origin.`);
  }
  return endpoint.toString();
}
function parseScopes(value, label = "n8n OAuth scope grant", allowedScopes = OAUTH_SCOPE_SET) {
  const values = typeof value === "string" ? value.split(/\s+/u).filter(Boolean) : Array.isArray(value) ? value : [];
  if (values.length === 0 || values.length > allowedScopes.size || values.some((entry) => typeof entry !== "string" || !allowedScopes.has(entry)) || new Set(values).size !== values.length) {
    throw new Error(`${label} is invalid or broader than the reviewed scope set.`);
  }
  return [...values].toSorted();
}
function capabilitiesFromScopes(scopes) {
  const granted = new Set(scopes);
  if (granted.size === OAUTH_SCOPES.length && OAUTH_SCOPES.every((scope2) => granted.has(scope2))) {
    return ["read", "write"];
  }
  if (granted.size === READ_OAUTH_SCOPES.length && READ_OAUTH_SCOPES.every((scope2) => granted.has(scope2))) {
    return ["read"];
  }
  return [];
}
function scopesForCapabilities(capabilities) {
  const selected = new Set(capabilities);
  const scopes = /* @__PURE__ */ new Set();
  if (selected.has("read") || selected.has("write")) {
    for (const scope2 of READ_OAUTH_SCOPES) scopes.add(scope2);
  }
  if (selected.has("write")) {
    for (const scope2 of WRITE_OAUTH_SCOPES) scopes.add(scope2);
  }
  return [...scopes].toSorted();
}
function parseCredential(encoded, serverUrl) {
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Stored n8n credential is invalid.");
  }
  const value = asRecord(parsed, "Stored n8n credential");
  const allowed = /* @__PURE__ */ new Set([
    "version",
    "serverUrl",
    "issuer",
    "clientId",
    "refreshToken",
    "scopes",
    "updatedAt"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || value.version !== 1 || value.serverUrl !== serverUrl || value.issuer !== new URL(serverUrl).origin || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Stored n8n credential is invalid.");
  }
  const scopes = parseScopes(value.scopes, "Stored n8n credential scope");
  if (capabilitiesFromScopes(scopes).length === 0) {
    throw new Error("Stored n8n credential has an unsupported custom scope grant.");
  }
  return {
    version: 1,
    serverUrl,
    issuer: value.issuer,
    clientId: boundedString(value.clientId, MAX_CLIENT_ID_CHARS, "Stored n8n credential"),
    refreshToken: boundedString(value.refreshToken, MAX_TOKEN_CHARS, "Stored n8n credential"),
    scopes,
    updatedAt: value.updatedAt
  };
}
async function readResponseBytes(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("n8n response exceeded the allowed size.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done: done2, value } = await reader.read();
      if (done2) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => void 0);
        throw new Error("n8n response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
function parseJson2(bytes, label = "n8n response") {
  try {
    return asRecord(JSON.parse(decoder.decode(bytes)), label);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} contained invalid JSON.`);
  }
}
function parseMcpPayload(response, bytes) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) return parseJson2(bytes, "n8n MCP response");
  if (!contentType.includes("text/event-stream")) {
    throw new Error("n8n MCP returned an invalid content type.");
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error("n8n MCP returned invalid event-stream text.");
  }
  text = text.replace(/\r\n?/gu, "\n");
  if (text.length === 0) {
    throw new Error("n8n MCP returned an invalid event stream.");
  }
  const events = text.split("\n\n").filter((block) => block.split("\n").some((line) => line !== "" && !line.startsWith(":")));
  if (events.length !== 1) throw new Error("n8n MCP returned an ambiguous event stream.");
  const lines = events[0].split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      if (line.slice(6).trim() !== "message") {
        throw new Error("n8n MCP returned an unsupported event type.");
      }
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim() === "" || line.startsWith("id:") || line.startsWith("retry:")) continue;
    throw new Error("n8n MCP returned an invalid event stream.");
  }
  if (dataLines.length === 0) throw new Error("n8n MCP event stream omitted response data.");
  return parseJson2(encoder2.encode(dataLines.join("\n")), "n8n MCP response");
}
function randomBase64Url(bytes) {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}
function timingSafeTextEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && NodeCrypto.timingSafeEqual(leftBytes, rightBytes);
}
function assertJsonBounds(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new IntegrationProviderPublicError("n8n tool input must be bounded JSON data.");
  }
  if (encoded === void 0 || Buffer.byteLength(encoded) > MAX_INPUT_BYTES) {
    throw new IntegrationProviderPublicError("n8n tool input exceeds the two-megabyte limit.");
  }
  const stack = [{ value, depth: 0 }];
  const seen = /* @__PURE__ */ new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new IntegrationProviderPublicError("n8n tool input is too deeply nested or complex.");
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new IntegrationProviderPublicError("n8n tool input must not contain cycles.");
    }
    seen.add(current.value);
    if (!Array.isArray(current.value) && ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))) {
      throw new IntegrationProviderPublicError("n8n tool input must contain only JSON objects.");
    }
    for (const child of Object.values(current.value)) {
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}
var STRUCTURAL_SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "$ref",
  "anyOf",
  "enum",
  "items",
  "oneOf",
  "properties",
  "required",
  "type"
]);
function resolveLocalSchemaReference(root, reference) {
  if (!reference.startsWith("#/")) return void 0;
  let current = root;
  for (const encodedSegment of reference.slice(2).split("/")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return void 0;
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(current, segment)) return void 0;
    current = current[segment];
  }
  return current;
}
function schemaContract(value, root = value, activeReferences = /* @__PURE__ */ new Set()) {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => schemaContract(entry, root, activeReferences));
    return mapped.every((entry) => typeof entry === "string") ? mapped.toSorted() : mapped;
  }
  if (!value || typeof value !== "object") return value;
  const record2 = value;
  if (typeof record2.$ref === "string" && !activeReferences.has(record2.$ref)) {
    const resolved = resolveLocalSchemaReference(root, record2.$ref);
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      const siblings = Object.fromEntries(Object.entries(record2).filter(([key]) => key !== "$ref"));
      return schemaContract(
        { ...resolved, ...siblings },
        root,
        /* @__PURE__ */ new Set([...activeReferences, record2.$ref])
      );
    }
  }
  const normalized = {};
  for (const key of Object.keys(record2).filter((entry) => STRUCTURAL_SCHEMA_KEYS.has(entry)).toSorted()) {
    if (key === "properties") {
      const properties = record2.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
      normalized.properties = Object.fromEntries(
        Object.keys(properties).toSorted().map((name) => [
          name,
          schemaContract(properties[name], root, activeReferences)
        ])
      );
      continue;
    }
    normalized[key] = schemaContract(record2[key], root, activeReferences);
  }
  if ("const" in record2 && !("enum" in record2)) {
    normalized.enum = [schemaContract(record2.const, root, activeReferences)];
  }
  if (normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties) && Object.keys(normalized.properties).length === 0) {
    delete normalized.properties;
  }
  if (Array.isArray(record2.prefixItems) && !("type" in normalized)) {
    normalized.type = "array";
  }
  if (Array.isArray(normalized.anyOf) && normalized.anyOf.every(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry) && entry.type === "string" && Array.isArray(entry.enum) && entry.enum.every(
      (value2) => typeof value2 === "string"
    ) && Object.keys(entry).every(
      (key) => key === "type" || key === "enum"
    )
  )) {
    normalized.type = "string";
    normalized.enum = [
      ...new Set(
        normalized.anyOf.flatMap((entry) => entry.enum)
      )
    ].toSorted();
    delete normalized.anyOf;
  }
  return normalized;
}
function firstSchemaDifference(actual, expected, path = "$") {
  if (Object.is(actual, expected)) return null;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      return { path: `${path}.length`, actual: actual.length, expected: expected.length };
    }
    for (let index = 0; index < actual.length; index += 1) {
      const difference = firstSchemaDifference(actual[index], expected[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && !Array.isArray(actual) && !Array.isArray(expected)) {
    const actualRecord = actual;
    const expectedRecord = expected;
    const keys = [
      .../* @__PURE__ */ new Set([...Object.keys(actualRecord), ...Object.keys(expectedRecord)])
    ].toSorted();
    for (const key of keys) {
      if (!(key in actualRecord) || !(key in expectedRecord)) {
        return {
          path: `${path}.${key}`,
          actual: actualRecord[key] ?? "<missing>",
          expected: expectedRecord[key] ?? "<missing>"
        };
      }
      const difference = firstSchemaDifference(
        actualRecord[key],
        expectedRecord[key],
        `${path}.${key}`
      );
      if (difference) return difference;
    }
    return null;
  }
  return { path, actual, expected };
}
function expectedSchema(tool) {
  return toJsonSchemaDocument2(tool.input).schema;
}
function validateToolInventory(value) {
  const result2 = asRecord(value, "n8n MCP tools/list result");
  if (!Array.isArray(result2.tools) || result2.tools.length > MAX_MCP_TOOLS) {
    throw new Error("n8n MCP tool inventory is invalid.");
  }
  const actual = /* @__PURE__ */ new Map();
  for (const raw of result2.tools) {
    const tool = asRecord(raw, "n8n MCP tool definition");
    const name = boundedString(tool.name, 128, "n8n MCP tool name");
    if (actual.has(name)) throw new Error("n8n MCP returned duplicate tools.");
    actual.set(name, tool);
  }
  const reviewedNames = new Set(REVIEWED_TOOLS.map((tool) => tool.upstreamName));
  const reviewedAvailable = new Set([...actual.keys()].filter((name) => reviewedNames.has(name)));
  if (reviewedAvailable.size === 0) {
    throw new IntegrationProviderPublicError(
      "n8n MCP no longer offers any tools from the reviewed catalog. Update the TritonAI n8n plugin before use."
    );
  }
  const schemaChanges = [];
  const schemaChangeDetails = [];
  const effectChanges = [];
  for (const reviewed of REVIEWED_TOOLS) {
    const upstream = actual.get(reviewed.upstreamName);
    if (!upstream) continue;
    const upstreamContract = schemaContract(upstream.inputSchema);
    const reviewedContract = schemaContract(expectedSchema(reviewed));
    if (!NodeUtil.isDeepStrictEqual(upstreamContract, reviewedContract)) {
      schemaChanges.push(reviewed.upstreamName);
      const difference = firstSchemaDifference(upstreamContract, reviewedContract);
      if (difference) {
        schemaChangeDetails.push(
          `${reviewed.upstreamName}${difference.path.slice(1)} actual=${JSON.stringify(difference.actual)} expected=${JSON.stringify(difference.expected)}`
        );
      }
      continue;
    }
    const annotations = upstream.annotations;
    if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) {
      effectChanges.push(reviewed.upstreamName);
      continue;
    }
    const hints = annotations;
    if (hints.readOnlyHint !== reviewed.readOnly || hints.destructiveHint !== reviewed.destructive || hints.idempotentHint !== reviewed.idempotent || hints.openWorldHint !== reviewed.openWorld) {
      effectChanges.push(reviewed.upstreamName);
    }
  }
  if (schemaChanges.length > 0) {
    throw new IntegrationProviderPublicError(
      `n8n MCP schema changed for: ${schemaChanges.join(", ")}. ${schemaChangeDetails.join("; ")}. Update the TritonAI n8n plugin before use.`
    );
  }
  if (effectChanges.length > 0) {
    throw new IntegrationProviderPublicError(
      `n8n MCP effect metadata changed for: ${effectChanges.join(", ")}.`
    );
  }
  return reviewedAvailable;
}
var SessionInvalidError = class extends Error {
};
var ConfirmedRemoteFailure = class extends IntegrationProviderPublicError {
};
var N8nProvider = class {
  id = N8N_PROVIDER_ID;
  tools = N8N_TOOLS;
  #secrets;
  #server;
  #fetch;
  #requestTimeoutMs;
  #pending = /* @__PURE__ */ new Map();
  #polling = /* @__PURE__ */ new Set();
  #requestControllers = /* @__PURE__ */ new Set();
  #accessToken = null;
  #sessionId = null;
  #sessionVerified = false;
  #availableTools = /* @__PURE__ */ new Set();
  #generation = 0;
  #connectAttempt = 0;
  #credentialRevision = 0;
  #rpcSequence = 0;
  #closed = false;
  #disconnecting = false;
  #uncertainCredentialState = false;
  #credentialMutation = Promise.resolve();
  #sessionMutation = Promise.resolve();
  constructor(secrets, configuration2, fetchImplementation = globalThis.fetch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.#secrets = secrets;
    this.#server = validateServerUrl(configuration2.serverUrl);
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 3e4) {
      throw new Error("n8n requires a bounded request timeout.");
    }
    this.#fetch = fetchImplementation;
    this.#requestTimeoutMs = requestTimeoutMs;
  }
  #serializeCredential(operation) {
    const run2 = this.#credentialMutation.then(operation, operation);
    this.#credentialMutation = run2.then(
      () => void 0,
      () => void 0
    );
    return run2;
  }
  #serializeSession(operation) {
    const run2 = this.#sessionMutation.then(operation, operation);
    this.#sessionMutation = run2.then(
      () => void 0,
      () => void 0
    );
    return run2;
  }
  async #request(url, init, maximumBytes, timeoutMs = this.#requestTimeoutMs) {
    if (this.#closed) throw new Error("n8n provider is closed.");
    let endpoint;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error("n8n request endpoint is invalid.");
    }
    if (endpoint.protocol !== "https:" || endpoint.origin !== this.#server.origin || endpoint.username !== "" || endpoint.password !== "") {
      throw new Error("n8n request endpoint is outside the reviewed origin.");
    }
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    this.#requestControllers.add(controller);
    const signals = [controller.signal, timeoutSignal];
    if (init.signal) signals.push(init.signal);
    try {
      const response = await this.#fetch(endpoint.toString(), {
        ...init,
        redirect: "error",
        signal: AbortSignal.any(signals)
      });
      return { response, bytes: await readResponseBytes(response, maximumBytes) };
    } catch (error) {
      if (init.signal?.aborted) {
        throw new IntegrationProviderPublicError("n8n request was cancelled.");
      }
      if (controller.signal.aborted || this.#closed) {
        throw new Error("n8n provider was closed.", { cause: error });
      }
      if (timeoutSignal.aborted) {
        throw new IntegrationProviderPublicError("n8n request timed out.");
      }
      throw error;
    } finally {
      this.#requestControllers.delete(controller);
    }
  }
  async #requestJson(url, init, maximumBytes) {
    const { response, bytes } = await this.#request(url, init, maximumBytes);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error("n8n OAuth endpoint returned an invalid content type.");
    }
    return { response, json: parseJson2(bytes) };
  }
  async #discover(signal) {
    const protectedUrl = new URL(
      `/.well-known/oauth-protected-resource${this.#server.pathname}`,
      this.#server.origin
    );
    const { response: protectedResponse, json: resource } = await this.#requestJson(
      protectedUrl.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES
    );
    if (!protectedResponse.ok) throw new Error("n8n OAuth protected-resource discovery failed.");
    if (resource.resource !== this.#server.toString()) {
      throw new Error("n8n OAuth resource metadata did not bind the configured server.");
    }
    if (!Array.isArray(resource.bearer_methods_supported) || resource.bearer_methods_supported.length !== 1 || resource.bearer_methods_supported[0] !== "header") {
      throw new Error("n8n OAuth bearer method drifted from the reviewed contract.");
    }
    exactStringSet(resource.scopes_supported, OAUTH_SCOPE_SET, "n8n OAuth resource scope metadata");
    if (!Array.isArray(resource.authorization_servers) || resource.authorization_servers.length !== 1) {
      throw new Error("n8n OAuth authorization server metadata is invalid.");
    }
    const issuer = sameOriginEndpoint(
      resource.authorization_servers[0],
      "/",
      this.#server.origin,
      "n8n OAuth authorization server"
    ).replace(/\/$/u, "");
    const metadataUrl = new URL("/.well-known/oauth-authorization-server", issuer);
    const { response, json } = await this.#requestJson(
      metadataUrl.toString(),
      { method: "GET", headers: { accept: "application/json" }, signal: signal ?? null },
      METADATA_RESPONSE_BYTES
    );
    if (!response.ok || json.issuer !== issuer) {
      throw new Error("n8n OAuth authorization metadata is invalid.");
    }
    exactStringSet(
      json.scopes_supported,
      OAUTH_SCOPE_SET,
      "n8n OAuth authorization scope metadata"
    );
    if (!Array.isArray(json.response_types_supported) || !json.response_types_supported.includes("code") || !Array.isArray(json.grant_types_supported) || !json.grant_types_supported.includes("authorization_code") || !json.grant_types_supported.includes("refresh_token") || !Array.isArray(json.token_endpoint_auth_methods_supported) || !json.token_endpoint_auth_methods_supported.includes("none") || !Array.isArray(json.code_challenge_methods_supported) || !json.code_challenge_methods_supported.includes("S256") || json.authorization_response_iss_parameter_supported !== true) {
      throw new Error("n8n OAuth protocol metadata drifted from the reviewed contract.");
    }
    return {
      issuer,
      authorizationEndpoint: sameOriginEndpoint(
        json.authorization_endpoint,
        "/mcp-oauth/authorize",
        this.#server.origin,
        "n8n OAuth authorization endpoint"
      ),
      tokenEndpoint: sameOriginEndpoint(
        json.token_endpoint,
        "/mcp-oauth/token",
        this.#server.origin,
        "n8n OAuth token endpoint"
      ),
      registrationEndpoint: sameOriginEndpoint(
        json.registration_endpoint,
        "/mcp-oauth/register",
        this.#server.origin,
        "n8n OAuth registration endpoint"
      ),
      revocationEndpoint: sameOriginEndpoint(
        json.revocation_endpoint,
        "/mcp-oauth/revoke",
        this.#server.origin,
        "n8n OAuth revocation endpoint"
      )
    };
  }
  async #registerClient(discovery, redirectUri, signal) {
    const request = {
      client_name: "TritonAI Harness n8n plugin",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
    const { response, json } = await this.#requestJson(
      discovery.registrationEndpoint,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
        signal
      },
      METADATA_RESPONSE_BYTES
    );
    if (response.status !== 200 && response.status !== 201) {
      throw new ConfirmedRemoteFailure("n8n could not register this local OAuth client.");
    }
    if (json.client_secret !== void 0 || json.token_endpoint_auth_method !== void 0 && json.token_endpoint_auth_method !== "none" || json.redirect_uris !== void 0 && (!Array.isArray(json.redirect_uris) || json.redirect_uris.length !== 1 || json.redirect_uris[0] !== redirectUri) || json.grant_types !== void 0 && (!Array.isArray(json.grant_types) || !json.grant_types.includes("authorization_code") || !json.grant_types.includes("refresh_token")) || json.response_types !== void 0 && (!Array.isArray(json.response_types) || !json.response_types.includes("code"))) {
      throw new Error("n8n dynamic client registration output is unsafe.");
    }
    return boundedString(json.client_id, MAX_CLIENT_ID_CHARS, "n8n dynamic client registration");
  }
  async #readCredential(signal) {
    if (signal?.aborted) throw new IntegrationProviderPublicError("n8n request was cancelled.");
    const value = await this.#secrets.get(N8N_SECRET_SUFFIX);
    if (signal?.aborted) throw new IntegrationProviderPublicError("n8n request was cancelled.");
    return value === null ? null : parseCredential(value, this.#server.toString());
  }
  async #writeCredential(credential, signal) {
    signal.throwIfAborted();
    await this.#secrets.set(N8N_SECRET_SUFFIX, JSON.stringify(credential));
    signal.throwIfAborted();
  }
  async #beginCommit(context2) {
    if (!context2 || typeof context2.beginCommit !== "function") {
      throw new Error("n8n credential mutation requires Harness commit admission.");
    }
    return context2.beginCommit();
  }
  async #closeFlowListener(flow, clearExpiryTimer) {
    if (clearExpiryTimer) clearTimeout(flow.timer);
    if (flow.closePromise) {
      if (clearExpiryTimer) flow.server.closeAllConnections();
      return flow.closePromise;
    }
    flow.closePromise = new Promise((resolve2) => {
      if (!flow.server.listening) {
        resolve2();
        return;
      }
      flow.server.close(() => resolve2());
      flow.server.closeIdleConnections();
      if (clearExpiryTimer) flow.server.closeAllConnections();
    });
    return flow.closePromise;
  }
  async #removeFlow(flowId) {
    const flow = this.#pending.get(flowId);
    if (!flow) return;
    this.#pending.delete(flowId);
    await this.#closeFlowListener(flow, true);
  }
  async #clearPendingFlows() {
    const flows = [...this.#pending.values()];
    this.#pending.clear();
    await Promise.all(flows.map((flow) => this.#closeFlowListener(flow, true)));
  }
  #writeCallbackPage(response, status, message) {
    const body = `<!doctype html><html><head><meta charset="utf-8"><title>TritonAI Harness</title></head><body><main><h1>${message}</h1><p>You can close this window and return to TritonAI Harness.</p></main></body></html>`;
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
  }
  #handleCallback(flow, request, response) {
    const address = flow.server.address();
    const expectedHost = address && typeof address === "object" ? `127.0.0.1:${address.port}` : "";
    const remote = request.socket.remoteAddress;
    if (request.method !== "GET" || request.headers.host !== expectedHost || remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1" || flow.expiresAt <= Date.now() || flow.generation !== this.#generation || this.#closed || this.#disconnecting || this.#pending.get(flow.flowId) !== flow) {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? "", `http://${expectedHost}`);
    } catch {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    const allowed = /* @__PURE__ */ new Set([
      "state",
      "iss",
      "code",
      "scope",
      "error",
      "error_description",
      "error_uri"
    ]);
    if (url.pathname !== CALLBACK_PATH || [...url.searchParams.keys()].some((key) => !allowed.has(key)) || [...new Set(url.searchParams.keys())].some(
      (key) => url.searchParams.getAll(key).length !== 1
    ) || url.searchParams.get("iss") !== flow.discovery.issuer || !timingSafeTextEqual(url.searchParams.get("state") ?? "", flow.state) || flow.consumed) {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");
    if (code === null === (oauthError === null)) {
      this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
      return;
    }
    if (code !== null) {
      if (code.length === 0 || code.length > MAX_TOKEN_CHARS) {
        this.#writeCallbackPage(response, 400, "This n8n sign-in callback is not valid.");
        return;
      }
      flow.consumed = true;
      flow.callback = { kind: "code", code };
      flow.callbackExpiresAt = Date.now() + FLOW_CALLBACK_CLAIM_MS;
      clearTimeout(flow.timer);
      flow.timer = setTimeout(() => {
        if (this.#pending.get(flow.flowId) === flow && !this.#polling.has(flow.flowId)) {
          this.#pending.delete(flow.flowId);
          void this.#closeFlowListener(flow, true);
        }
      }, FLOW_CALLBACK_CLAIM_MS);
      flow.timer.unref();
      this.#writeCallbackPage(response, 200, "n8n sign-in received.");
    } else {
      flow.consumed = true;
      flow.callback = {
        kind: "error",
        error: oauthError && oauthError.length <= 256 ? oauthError : "authorization_denied"
      };
      this.#writeCallbackPage(response, 200, "n8n sign-in was not completed.");
    }
    response.once("finish", () => void this.#closeFlowListener(flow, false));
  }
  async #startFlowListener(input, signal) {
    let flow = null;
    const server = NodeHttp.createServer((request, response) => {
      if (!flow) {
        this.#writeCallbackPage(response, 503, "This n8n sign-in callback is not ready.");
        return;
      }
      this.#handleCallback(flow, request, response);
    });
    server.maxHeadersCount = 32;
    server.headersTimeout = 5e3;
    server.requestTimeout = 5e3;
    server.keepAliveTimeout = 1;
    await new Promise((resolve2, reject) => {
      const onError2 = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError2);
        resolve2();
      };
      server.once("error", onError2);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise((resolve2) => server.close(() => resolve2()));
      throw new Error("n8n loopback listener did not bind safely.");
    }
    const timer = setTimeout(
      () => {
        if (this.#pending.get(input.flowId) === flow) {
          this.#pending.delete(input.flowId);
          if (flow) void this.#closeFlowListener(flow, true);
        }
      },
      Math.max(1, input.expiresAt - Date.now())
    );
    timer.unref();
    flow = {
      ...input,
      server,
      timer,
      redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
      clientId: "",
      callbackExpiresAt: null,
      callback: null,
      consumed: false,
      closePromise: null
    };
    if (signal?.aborted || this.#closed || this.#disconnecting) {
      await this.#closeFlowListener(flow, true);
      throw new IntegrationProviderPublicError("n8n sign-in was cancelled.");
    }
    return flow;
  }
  async #mcpRpc(access, method, params, signal, maximumBytes, timeoutMs = this.#requestTimeoutMs) {
    const id = `${++this.#rpcSequence}`;
    const metadata = {
      [MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
      [MCP_CLIENT_CAPABILITIES_META_KEY]: {},
      [MCP_CLIENT_INFO_META_KEY]: MCP_CLIENT_INFO
    };
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: metadata }
    };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
      throw new IntegrationProviderPublicError("n8n MCP request exceeded the allowed size.");
    }
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${access.value}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION
    };
    if (method === "tools/call") {
      headers["mcp-name"] = boundedString(params?.name, 128, "n8n MCP tool name");
    }
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    const { response, bytes } = await this.#request(
      this.#server.toString(),
      { method: "POST", headers, body, signal },
      maximumBytes,
      timeoutMs
    );
    if (response.status === 401) {
      this.#accessToken = null;
      this.#sessionId = null;
      this.#sessionVerified = false;
      this.#availableTools = /* @__PURE__ */ new Set();
      throw new ConfirmedRemoteFailure("n8n authorization expired. Reconnect if refresh fails.");
    }
    if (response.status === 404 && this.#sessionId) {
      this.#sessionId = null;
      this.#sessionVerified = false;
      throw new SessionInvalidError("n8n MCP session expired.");
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw new ConfirmedRemoteFailure("n8n is rate limiting MCP requests. Try again later.");
      }
      if (response.status === 403) {
        throw new ConfirmedRemoteFailure("n8n denied this operation for the connected user.");
      }
      throw new ConfirmedRemoteFailure(
        `n8n MCP ${method} failed (HTTP ${response.status}). Reconnect and try again.`
      );
    }
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession !== null) {
      if (returnedSession.length === 0 || returnedSession.length > MAX_SESSION_ID_CHARS || !/^[\x21-\x7E]+$/u.test(returnedSession)) {
        throw new Error("n8n MCP returned an invalid session identifier.");
      }
      if (this.#sessionId !== null && this.#sessionId !== returnedSession) {
        throw new Error("n8n MCP changed session identifiers unexpectedly.");
      }
      this.#sessionId = returnedSession;
    }
    const raw = parseMcpPayload(response, bytes);
    if (raw.jsonrpc !== "2.0" || raw.id !== id) {
      throw new Error("n8n MCP returned a mismatched JSON-RPC response.");
    }
    if (raw.error !== void 0) {
      const error = asRecord(raw.error, "n8n MCP JSON-RPC error");
      if (!Number.isInteger(error.code)) throw new Error("n8n MCP returned an invalid error.");
      throw new ConfirmedRemoteFailure("n8n MCP rejected the request.");
    }
    if (!("result" in raw)) throw new Error("n8n MCP response omitted its result.");
    return raw.result;
  }
  async #initializeSession(access, signal) {
    await this.#serializeSession(async () => {
      if (this.#sessionVerified) return;
      this.#sessionId = null;
      const discover = asRecord(
        await this.#mcpRpc(
          access,
          "server/discover",
          void 0,
          signal,
          MCP_CONTROL_RESPONSE_BYTES
        ),
        "n8n MCP server/discover result"
      );
      if (discover.resultType !== "complete" || !Array.isArray(discover.supportedVersions) || discover.supportedVersions.length > 16 || !discover.supportedVersions.every((version2) => typeof version2 === "string") || !discover.supportedVersions.includes(MCP_PROTOCOL_VERSION) || !discover.capabilities || typeof discover.capabilities !== "object" || Array.isArray(discover.capabilities) || !discover.capabilities.tools || typeof discover.capabilities.tools !== "object" || Array.isArray(discover.capabilities.tools)) {
        throw new IntegrationProviderPublicError(
          "n8n MCP protocol changed from the reviewed version."
        );
      }
      const collected = [];
      let cursor;
      for (let page = 0; page < MAX_MCP_PAGES; page += 1) {
        const result2 = asRecord(
          await this.#mcpRpc(
            access,
            "tools/list",
            cursor === void 0 ? void 0 : { cursor },
            signal,
            MCP_CONTROL_RESPONSE_BYTES
          ),
          "n8n MCP tools/list result"
        );
        if (result2.resultType !== "complete" || !Array.isArray(result2.tools)) {
          throw new Error("n8n MCP tool inventory is invalid.");
        }
        collected.push(...result2.tools.map((tool) => asRecord(tool, "n8n MCP tool definition")));
        if (collected.length > MAX_MCP_TOOLS)
          throw new Error("n8n MCP tool inventory is too large.");
        if (result2.nextCursor === void 0 || result2.nextCursor === null) {
          cursor = void 0;
          break;
        }
        cursor = boundedString(result2.nextCursor, 2048, "n8n MCP tools cursor");
      }
      if (cursor !== void 0) throw new Error("n8n MCP tool inventory pagination is too large.");
      this.#availableTools = validateToolInventory({ tools: collected });
      this.#sessionVerified = true;
    });
  }
  async #revokeToken(discovery, token, clientId, signal) {
    const { response } = await this.#request(
      discovery.revocationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          token,
          token_type_hint: "refresh_token"
        }),
        signal
      },
      METADATA_RESPONSE_BYTES
    );
    if (!response.ok) {
      throw new ConfirmedRemoteFailure("n8n could not revoke the credential. Try again.");
    }
  }
  #parseTokenResponse(json, clientId, discovery, existingRefreshToken, allowedScopes = OAUTH_SCOPE_SET) {
    if (json.token_type !== "Bearer" && json.token_type !== "bearer") {
      throw new Error("n8n OAuth returned an invalid token type.");
    }
    const accessToken = boundedString(json.access_token, MAX_TOKEN_CHARS, "n8n OAuth access token");
    const refreshToken = json.refresh_token === void 0 ? existingRefreshToken : boundedString(json.refresh_token, MAX_TOKEN_CHARS, "n8n OAuth refresh token");
    if (!refreshToken) throw new Error("n8n OAuth did not issue renewable access.");
    const expiresIn = boundedInteger(json.expires_in, 60, 86400, "n8n OAuth token lifetime");
    const scopes = parseScopes(json.scope, "n8n OAuth scope grant", allowedScopes);
    return {
      credential: {
        version: 1,
        serverUrl: this.#server.toString(),
        issuer: discovery.issuer,
        clientId,
        refreshToken,
        scopes,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      access: {
        value: accessToken,
        expiresAt: Date.now() + expiresIn * 1e3,
        clientId,
        discovery
      }
    };
  }
  async status(context2) {
    if (this.#uncertainCredentialState) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "Credential state is uncertain. Disconnect to verify reset before reconnecting."
      };
    }
    if (this.#closed || this.#disconnecting) {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: this.#closed ? "The n8n provider is closed." : "n8n is disconnecting."
      };
    }
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    try {
      const credential = await this.#readCredential(context2?.signal);
      if (generation !== this.#generation || revision !== this.#credentialRevision || this.#closed || this.#disconnecting) {
        throw new Error("n8n connection changed during status.");
      }
      if (!credential) {
        return {
          state: this.#pending.size > 0 ? "connecting" : "not_connected",
          accountLabel: null,
          grantedCapabilities: [],
          message: null
        };
      }
      return {
        state: "connected",
        accountLabel: this.#server.hostname,
        grantedCapabilities: capabilitiesFromScopes(credential.scopes),
        message: "Connected with the n8n user's own permissions."
      };
    } catch {
      return {
        state: "error",
        accountLabel: null,
        grantedCapabilities: [],
        message: "The stored n8n connection could not be verified. Disconnect to reset it."
      };
    }
  }
  async connect(capabilities, context2, submission) {
    if (submission !== void 0)
      throw new Error("n8n browser OAuth rejects credential submissions.");
    if (this.#closed || this.#disconnecting) throw new Error("n8n is unavailable.");
    if (this.#uncertainCredentialState) throw new Error("n8n credential state is uncertain.");
    if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length || capabilities.some((capability) => !CAPABILITY_SET.has(capability))) {
      throw new Error("Unsupported n8n capability.");
    }
    const requestedScopes = scopesForCapabilities(capabilities);
    const generation = this.#generation;
    const revision = this.#credentialRevision;
    const attempt = ++this.#connectAttempt;
    const existing = await this.#readCredential(context2?.signal);
    if (existing) {
      if (!requestedScopes.every((scope2) => existing.scopes.includes(scope2))) {
        throw new IntegrationProviderPublicError(
          "Disconnect and reconnect n8n to approve the additional access."
        );
      }
      return {
        kind: "connected",
        flowId: NodeCrypto.randomUUID(),
        message: "n8n is already authorized for this user."
      };
    }
    const discovery = await this.#discover(context2?.signal);
    await this.#clearPendingFlows();
    const flowId = NodeCrypto.randomUUID();
    const state = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const expiresAt = Date.now() + FLOW_LIFETIME_MS;
    const flow = await this.#startFlowListener(
      { flowId, state, codeVerifier, discovery, requestedScopes, expiresAt, generation },
      context2?.signal
    );
    let admitted = false;
    try {
      const commitSignal = await this.#beginCommit(context2);
      admitted = true;
      const clientId = await this.#registerClient(discovery, flow.redirectUri, commitSignal);
      if (generation !== this.#generation || revision !== this.#credentialRevision || attempt !== this.#connectAttempt || this.#closed || this.#disconnecting) {
        throw new Error("n8n sign-in was superseded while starting.");
      }
      flow.clientId = clientId;
      this.#pending.set(flowId, flow);
    } catch (error) {
      await this.#closeFlowListener(flow, true);
      if (admitted && !(error instanceof ConfirmedRemoteFailure)) {
        this.#uncertainCredentialState = true;
        throw new ExternalCommitOutcomeUnknownError(
          "The n8n OAuth client registration may have completed. Disconnect before retrying."
        );
      }
      throw error;
    }
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", flow.clientId);
    authorizationUrl.searchParams.set("redirect_uri", flow.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", requestedScopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      NodeCrypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url")
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("resource", this.#server.toString());
    return {
      kind: "authorization_url",
      flowId,
      authorizationUrl: authorizationUrl.toString(),
      message: "Continue in your browser and approve n8n access for your own account.",
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds: FLOW_POLL_SECONDS
    };
  }
  async poll(flowId, context2) {
    const flow = this.#pending.get(flowId);
    if (!flow) throw new IntegrationProviderPublicError("n8n sign-in flow was not found.");
    if (this.#polling.has(flowId)) {
      throw new IntegrationProviderPublicError("n8n sign-in is already being checked.");
    }
    if (flow.callback?.kind === "code" ? flow.callbackExpiresAt !== null && flow.callbackExpiresAt <= Date.now() : flow.expiresAt <= Date.now()) {
      await this.#removeFlow(flowId);
      return {
        state: "expired",
        retryAfterSeconds: null,
        message: "n8n sign-in expired. Start again."
      };
    }
    if (flow.callback === null) {
      return {
        state: "pending",
        retryAfterSeconds: FLOW_POLL_SECONDS,
        message: "Waiting for n8n sign-in."
      };
    }
    if (flow.callback.kind === "error") {
      await this.#removeFlow(flowId);
      return {
        state: "failed",
        retryAfterSeconds: null,
        message: flow.callback.error === "access_denied" ? "n8n sign-in was cancelled." : "n8n sign-in did not complete. Start again."
      };
    }
    const authorizationCode = flow.callback.code;
    this.#polling.add(flowId);
    try {
      return await this.#serializeCredential(async () => {
        if (this.#closed || this.#disconnecting || this.#uncertainCredentialState || flow.generation !== this.#generation || this.#pending.get(flowId) !== flow) {
          throw new Error("n8n sign-in was superseded before token exchange.");
        }
        let admitted = false;
        let responseSettled = false;
        let credentialIssued = false;
        let credentialCompensated = false;
        try {
          const commitSignal = await this.#beginCommit(context2);
          admitted = true;
          const { response, json } = await this.#requestJson(
            flow.discovery.tokenEndpoint,
            {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded"
              },
              body: new URLSearchParams({
                client_id: flow.clientId,
                code: authorizationCode,
                code_verifier: flow.codeVerifier,
                grant_type: "authorization_code",
                redirect_uri: flow.redirectUri,
                resource: this.#server.toString()
              }),
              signal: commitSignal
            },
            TOKEN_RESPONSE_BYTES
          );
          responseSettled = true;
          if (!response.ok) {
            await this.#removeFlow(flowId);
            return {
              state: "failed",
              retryAfterSeconds: null,
              message: "n8n sign-in failed. Start again."
            };
          }
          credentialIssued = true;
          const parsed = this.#parseTokenResponse(
            json,
            flow.clientId,
            flow.discovery,
            void 0,
            new Set(flow.requestedScopes)
          );
          if (capabilitiesFromScopes(parsed.credential.scopes).length === 0) {
            await this.#revokeToken(
              flow.discovery,
              parsed.credential.refreshToken,
              parsed.credential.clientId,
              commitSignal
            );
            credentialCompensated = true;
            await this.#removeFlow(flowId);
            return {
              state: "failed",
              retryAfterSeconds: null,
              message: "Choose All or Read only in n8n. Custom scope combinations are not supported."
            };
          }
          this.#accessToken = parsed.access;
          this.#sessionId = null;
          this.#sessionVerified = false;
          this.#availableTools = /* @__PURE__ */ new Set();
          try {
            await this.#initializeSession(parsed.access, commitSignal);
          } catch (error) {
            try {
              await this.#revokeToken(
                flow.discovery,
                parsed.credential.refreshToken,
                parsed.credential.clientId,
                commitSignal
              );
              credentialCompensated = true;
            } catch {
              this.#uncertainCredentialState = true;
            }
            this.#accessToken = null;
            this.#sessionId = null;
            this.#sessionVerified = false;
            this.#availableTools = /* @__PURE__ */ new Set();
            await this.#removeFlow(flowId);
            return {
              state: "failed",
              retryAfterSeconds: null,
              message: error instanceof IntegrationProviderPublicError ? error.message : "n8n MCP connection verification failed. Try again."
            };
          }
          if (this.#closed || this.#disconnecting || this.#uncertainCredentialState || flow.generation !== this.#generation || this.#pending.get(flowId) !== flow) {
            throw new Error("n8n sign-in was superseded before credential commit.");
          }
          await this.#writeCredential(parsed.credential, commitSignal);
          this.#credentialRevision += 1;
          this.#generation += 1;
          await this.#removeFlow(flowId);
          return {
            state: "connected",
            retryAfterSeconds: null,
            message: "n8n is connected for this user."
          };
        } catch (error) {
          if (admitted && (!responseSettled || credentialIssued && !credentialCompensated)) {
            this.#uncertainCredentialState = true;
            throw new ExternalCommitOutcomeUnknownError(
              "The n8n sign-in commit may have completed. Disconnect before retrying."
            );
          }
          throw error;
        }
      });
    } finally {
      this.#polling.delete(flowId);
    }
  }
  prepare(context2) {
    return this.#serializeCredential(async () => {
      if (this.#closed || this.#disconnecting) throw new Error("n8n is unavailable.");
      if (this.#uncertainCredentialState) throw new Error("n8n credential state is uncertain.");
      const access = this.#accessToken;
      if (access && access.expiresAt - ACCESS_TOKEN_SKEW_MS > Date.now()) {
        await this.#initializeSession(access, context2?.signal ?? new AbortController().signal);
        return;
      }
      const generation = this.#generation;
      const revision = this.#credentialRevision;
      const credential = await this.#readCredential(context2?.signal);
      if (!credential) return;
      const discovery = await this.#discover(context2?.signal);
      if (discovery.issuer !== credential.issuer) {
        throw new Error("n8n OAuth issuer changed from the stored credential.");
      }
      let admitted = false;
      let responseSettled = false;
      let credentialIssued = false;
      try {
        const commitSignal = await this.#beginCommit(context2);
        admitted = true;
        const { response, json } = await this.#requestJson(
          discovery.tokenEndpoint,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
              client_id: credential.clientId,
              grant_type: "refresh_token",
              refresh_token: credential.refreshToken,
              resource: this.#server.toString(),
              scope: credential.scopes.join(" ")
            }),
            signal: commitSignal
          },
          TOKEN_RESPONSE_BYTES
        );
        responseSettled = true;
        if (!response.ok) {
          throw new IntegrationProviderPublicError(
            "n8n access could not be refreshed. Disconnect and reconnect."
          );
        }
        credentialIssued = true;
        const parsed = this.#parseTokenResponse(
          json,
          credential.clientId,
          discovery,
          credential.refreshToken,
          new Set(credential.scopes)
        );
        if (capabilitiesFromScopes(parsed.credential.scopes).length === 0) {
          throw new IntegrationProviderPublicError(
            "n8n returned an unsupported custom scope grant. Disconnect and reconnect."
          );
        }
        if (generation !== this.#generation || revision !== this.#credentialRevision) {
          throw new Error("n8n connection changed while refreshing.");
        }
        this.#accessToken = parsed.access;
        this.#sessionId = null;
        this.#sessionVerified = false;
        this.#availableTools = /* @__PURE__ */ new Set();
        await this.#initializeSession(parsed.access, commitSignal);
        await this.#writeCredential(parsed.credential, commitSignal);
        this.#credentialRevision += 1;
      } catch (error) {
        if (admitted && (!responseSettled || credentialIssued)) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            "The n8n credential refresh may have completed. Disconnect before retrying."
          );
        }
        throw error;
      }
    });
  }
  disconnect(context2) {
    return this.#serializeCredential(async () => {
      this.#disconnecting = true;
      this.#generation += 1;
      this.#connectAttempt += 1;
      this.#sessionId = null;
      this.#sessionVerified = false;
      this.#availableTools = /* @__PURE__ */ new Set();
      await this.#clearPendingFlows();
      let admitted = false;
      try {
        const credential = await this.#readCredential(context2?.signal);
        const commitSignal = await this.#beginCommit(context2);
        admitted = true;
        if (credential) {
          const discovery = await this.#discover(commitSignal);
          await this.#revokeToken(
            discovery,
            credential.refreshToken,
            credential.clientId,
            commitSignal
          );
        }
        await this.#secrets.remove(N8N_SECRET_SUFFIX);
        commitSignal.throwIfAborted();
        this.#accessToken = null;
        this.#credentialRevision += 1;
        this.#uncertainCredentialState = false;
      } catch (error) {
        if (admitted) {
          this.#uncertainCredentialState = true;
          throw new ExternalCommitOutcomeUnknownError(
            "The n8n disconnect may have completed. Verify the connection state before retrying."
          );
        }
        throw error;
      } finally {
        this.#disconnecting = false;
      }
    });
  }
  async invoke(toolName, input, context2) {
    const reviewed = REVIEWED_TOOLS.find((tool) => tool.name === toolName);
    if (!reviewed) throw new IntegrationProviderPublicError("Unknown n8n tool.");
    if (!reviewed.readOnly && context2?.writeApproved !== true) {
      throw new Error("n8n writes require explicit Harness approval.");
    }
    const decoded = await decodeUnknownPromise(reviewed.input)(input, {
      errors: "all",
      onExcessProperty: "error"
    });
    assertJsonBounds(decoded);
    const generation = this.#generation;
    const access = this.#accessToken;
    if (!access || access.expiresAt - ACCESS_TOKEN_SKEW_MS <= Date.now() || !this.#sessionVerified || this.#closed || this.#disconnecting || this.#uncertainCredentialState) {
      throw new IntegrationProviderPublicError(
        "n8n access is not prepared. Reconnect if this continues."
      );
    }
    if (!this.#availableTools.has(reviewed.upstreamName)) {
      throw new IntegrationProviderPublicError(
        "This n8n tool is not available under the connected user's grant or instance configuration."
      );
    }
    let admitted = false;
    const signal = reviewed.readOnly ? context2?.signal : typeof context2?.beginCommit === "function" ? await context2.beginCommit().then((commitSignal) => {
      admitted = true;
      return commitSignal;
    }) : (() => {
      throw new Error("n8n writes require Harness commit admission.");
    })();
    if (!signal) throw new Error("n8n invocation requires a cancellation signal.");
    const timeout2 = reviewed.upstreamName === "test_workflow" ? TEST_REQUEST_TIMEOUT_MS : this.#requestTimeoutMs;
    const call = async () => {
      const result2 = asRecord(
        await this.#mcpRpc(
          access,
          "tools/call",
          { name: reviewed.upstreamName, arguments: decoded },
          signal,
          MCP_TOOL_RESPONSE_BYTES,
          timeout2
        ),
        "n8n MCP tool result"
      );
      if (result2.resultType !== "complete") {
        throw new ConfirmedRemoteFailure(
          "n8n requested an interactive MCP response that TritonAI Harness does not support."
        );
      }
      if (result2.isError === true) {
        throw new ConfirmedRemoteFailure("n8n reported that the tool operation failed.");
      }
      const structured = result2.structuredContent;
      if (structured && typeof structured === "object" && !Array.isArray(structured)) {
        const record2 = structured;
        if (record2.status === "error" || typeof record2.error === "string") {
          throw new ConfirmedRemoteFailure("n8n reported that the tool operation failed.");
        }
      }
      if (generation !== this.#generation || this.#closed || this.#disconnecting) {
        throw new Error("n8n access changed during the tool call.");
      }
      return result2;
    };
    try {
      return await call();
    } catch (error) {
      if (error instanceof SessionInvalidError && reviewed.readOnly) {
        await this.#initializeSession(access, signal);
        return call();
      }
      if (!reviewed.readOnly && admitted) {
        this.#uncertainCredentialState = true;
        throw new ExternalCommitOutcomeUnknownError(
          "The n8n operation may have completed. Verify its result before retrying."
        );
      }
      throw error;
    }
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#connectAttempt += 1;
    for (const controller of this.#requestControllers) controller.abort();
    await this.#clearPendingFlows();
    this.#accessToken = null;
    this.#sessionId = null;
    this.#sessionVerified = false;
    this.#availableTools = /* @__PURE__ */ new Set();
  }
};

// src/index.ts
var SERVER_URL = "https://n8n.tritonai.ucsd.edu/mcp-server/http";
function configuration(value) {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).toSorted().join(",") !== "serverUrl" || value.serverUrl !== SERVER_URL) {
    throw new Error("n8n configuration must contain only the reviewed server URL.");
  }
  return { serverUrl: value.serverUrl };
}
var createIntegrationProvider = ({
  secrets,
  configuration: input
}) => new N8nProvider(secrets, configuration(input));
export {
  createIntegrationProvider
};
