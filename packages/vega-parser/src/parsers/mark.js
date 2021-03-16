import parseEncode from './encode';
import clip from './marks/clip';
import definition from './marks/definition';
import interactive from './marks/interactive';
import parseData from './marks/data';
import parseFacet from './marks/facet';
import parseSubflow from './marks/subflow';
import getRole from './marks/role';
import {GroupMark} from './marks/marktypes';
import {FrameRole, MarkRole, ScopeRole} from './marks/roles';
import parseTransform from './transform';
import parseTrigger from './trigger';
import DataScope from '../DataScope';
import {fieldRef, isSignal, ref} from '../util';
import {error} from 'vega-util';
import {Bound, Collect, DataJoin, Encode, Mark, Overlap, Render, Sieve, SortItems, ViewLayout} from '../transforms';

export default function(spec, scope) {
  const role = getRole(spec);
  const group = spec.type === GroupMark;
  const facet = spec.from && spec.from.facet;
  const overlap = spec.overlap;
  let layout = spec.layout || role === ScopeRole || role === FrameRole;
  let ops;
  let op;
  let store;
  let enc;
  let name;
  let layoutRef;
  let boundRef;

  const nested = role === MarkRole || layout || facet;

  // resolve input data
  const input = parseData(spec.from, group, scope);

  // data join to map tuples to visual items
  op = scope.add(DataJoin({
    key:   input.key || (spec.key ? fieldRef(spec.key) : undefined),
    pulse: input.pulse,
    clean: !group
  }));
  const joinRef = ref(op);

  // collect visual items
  op = store = scope.add(Collect({pulse: joinRef}));

  // connect visual items to scenegraph
  op = scope.add(Mark({
    markdef:     definition(spec),
    interactive: interactive(spec.interactive, scope),
    clip:        clip(spec.clip, scope),
    context:     {$context: true},
    groups:      scope.lookup(),
    parent:      scope.signals.parent ? scope.signalRef('parent') : null,
    index:       scope.markpath(),
    pulse:       ref(op)
  }));
  const markRef = ref(op);

  // add visual encoders
  op = enc = scope.add(Encode(parseEncode(
    spec.encode, spec.type, role, spec.style, scope,
    {mod: false, pulse: markRef}
  )));

  // monitor parent marks to propagate changes
  op.params.parent = scope.encode();

  // add post-encoding transforms, if defined
  if (spec.transform) {
    spec.transform.forEach(_ => {
      const tx = parseTransform(_, scope);
      const md = tx.metadata;
      if (md.generates || md.changes) {
        error('Mark transforms should not generate new data.');
      }
      if (!md.nomod) enc.params.mod = true; // update encode mod handling
      tx.params.pulse = ref(op);
      scope.add(op = tx);
    });
  }

  // if item sort specified, perform post-encoding
  if (spec.sort) {
    op = scope.add(SortItems({
      sort:  scope.compareRef(spec.sort),
      pulse: ref(op)
    }));
  }

  const encodeRef = ref(op);

  // add view layout operator if needed
  if (facet || layout) {
    layout = scope.add(ViewLayout({
      layout:   scope.objectProperty(spec.layout),
      legends:  scope.legends,
      mark:     markRef,
      pulse:    encodeRef
    }));
    layoutRef = ref(layout);
  }

  // compute bounding boxes
  const bound = scope.add(Bound({mark: markRef, pulse: layoutRef || encodeRef}));
  boundRef = ref(bound);

  // if group mark, recurse to parse nested content
  if (group) {
    // juggle layout & bounds to ensure they run *after* any faceting transforms
    if (nested) { ops = scope.operators; ops.pop(); if (layout) ops.pop(); }

    scope.pushState(encodeRef, layoutRef || boundRef, joinRef);
    facet ? parseFacet(spec, scope, input)          // explicit facet
        : nested ? parseSubflow(spec, scope, input) // standard mark group
        : scope.parse(spec); // guide group, we can avoid nested scopes
    scope.popState();

    if (nested) { if (layout) ops.push(layout); ops.push(bound); }
  }

  // if requested, add overlap removal transform
  if (overlap) {
    boundRef = parseOverlap(overlap, boundRef, scope);
  }

  // render / sieve items
  const render = scope.add(Render({pulse: boundRef}));

  const sieve = scope.add(Sieve({pulse: ref(render)}, undefined, scope.parent()));

  // if mark is named, make accessible as reactive geometry
  // add trigger updates if defined
  if (spec.name != null) {
    name = spec.name;
    scope.addData(name, new DataScope(scope, store, render, sieve));
    if (spec.on) spec.on.forEach(on => {
      if (on.insert || on.remove || on.toggle) {
        error('Marks only support modify triggers.');
      }
      parseTrigger(on, scope, name);
    });
  }
}

function parseOverlap(overlap, source, scope) {
  const method = overlap.method;
  const bound = overlap.bound;
  const sep = overlap.separation;

  const params = {
    separation: isSignal(sep) ? scope.signalRef(sep.signal) : sep,
    method: isSignal(method) ? scope.signalRef(method.signal) : method,
    pulse:  source
  };

  if (overlap.order) {
    params.sort = scope.compareRef({field: overlap.order});
  }

  if (bound) {
    const tol = bound.tolerance;
    params.boundTolerance = isSignal(tol) ? scope.signalRef(tol.signal) : +tol;
    params.boundScale = scope.scaleRef(bound.scale);
    params.boundOrient = bound.orient;
  }

  return ref(scope.add(Overlap(params)));
}
