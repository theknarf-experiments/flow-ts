// PEG grammar for FlowLog. Ported from flowlog/src/parsing/src/grammar.pest.
//
// The grammar actions call `options.b.<name>(...)` to construct AST nodes,
// so the AST classes/types stay in the dedicated TS modules and the grammar
// stays decoupled from how nodes are represented.

{{
  // No imports here — actions reference options.b for AST builders.
}}

Program
  = _ sections:Section+ _ {
      const edbs = [];
      const idbs = [];
      const rules = [];
      const queryIdbs = [];
      const bareGoals = [];
      for (const s of sections) {
        if (s.edbs) for (const e of s.edbs) edbs.push(e);
        if (s.idbs) for (const i of s.idbs) idbs.push(i);
        if (s.queryIdbs) for (const q of s.queryIdbs) queryIdbs.push(q);
        if (s.bareGoals) for (const g of s.bareGoals) bareGoals.push(g);
        if (s.rules) for (const r of s.rules) rules.push(r);
      }
      // A `?-` query declares its own head. Skip one whose name is already
      // declared — by an explicit `.decl`, or by an earlier query with the
      // same head, which is how a query writes a union. The explicit
      // declaration wins: it is a statement, and the query is shorthand for
      // not having made one.
      const declared = new Set();
      for (const d of edbs) declared.add(d.name);
      for (const d of idbs) declared.add(d.name);
      for (const q of queryIdbs) {
        if (declared.has(q.name)) continue;
        declared.add(q.name);
        idbs.push(q);
      }
      // A bare goal has no name, so one is made up here — after every declared
      // name is known, so the throwaway can't shadow a real relation. Numbered
      // in source order, and only over the bare goals, so a program's names are
      // a function of its text and nothing else.
      let seq = 0;
      for (const g of bareGoals) {
        let name;
        do { name = "Query" + (++seq); } while (declared.has(name));
        declared.add(name);
        const args = options.b.bareQueryColumns(g.rhs).map(v => options.b.headArgVar(v));
        idbs.push(options.b.relDecl(name, [], null));
        rules.push(options.b.rule(options.b.head(name, args), g.rhs, g.planning, g.sip));
      }
      return options.b.program(edbs, idbs, rules);
    }

// Each section is one of: (edb + idb), edb alone, or idb alone — optionally
// followed by a rule block. Matches the pest main_grammar pattern. A run of
// `?-` queries is a section of its own, since it brings its own declarations.
Section
  = edbs:EdbDecl _ idbs:IdbDecl _ rules:RuleDecl? _ { return { edbs, idbs, rules: rules || [] }; }
  / edbs:EdbDecl _ rules:RuleDecl? _ { return { edbs, rules: rules || [] }; }
  / idbs:IdbDecl _ rules:RuleDecl? _ { return { idbs, rules: rules || [] }; }
  / q:QueryDecl _ { return { queryIdbs: q.queryIdbs, rules: q.rules, bareGoals: q.bareGoals }; }

EdbDecl
  = ".in" _ first:EdbRelationDecl rest:(_ EdbRelationDecl)* {
      return [first, ...rest.map(r => r[1])];
    }

IdbDecl
  = (".printsize" / ".out") _ first:IdbRelationDecl rest:(_ IdbRelationDecl)* {
      return [first, ...rest.map(r => r[1])];
    }

EdbRelationDecl
  = ".decl" _ name:RelationName _ "(" _ attrs:AttributesDecl _ ")" path:(_ InDecl)? {
      return options.b.relDecl(name, attrs, path ? path[1] : null);
    }

IdbRelationDecl
  = ".decl" _ name:RelationName _ "(" _ attrs:AttributesDecl? _ ")" path:(_ OutDecl)? put:(_ PutDecl)? {
      return options.b.relDecl(name, attrs || [], path ? path[1] : null, put ? put[1] : null);
    }

// How this relation is written back. Attaches to the declaration the way
// `.input` attaches to an EDB's: the policy is a property of the relation,
// not of a request that arrives later.
PutDecl
  = ".put" _ "spread" _ "(" _ r:Residual _ ")" { return { kind: "spread", residual: r }; }
  / ".put" _ "insert" _ "via" _ name:RelationName d:(_ InsertDefaults)? {
      return { kind: "insert", via: name, defaults: d ? d[1] : [] };
    }
  / ".put" _ "insert" _ d:InsertDefaults { return { kind: "insert", via: null, defaults: d }; }
  / ".put" _ "into" _ name:RelationName { return { kind: "into", rel: name }; }
  / ".put" _ "none" { return { kind: "none" }; }

Residual
  = "min" { return "min"; }
  / "max" { return "max"; }

InsertDefaults
  = "defaults" _ "(" _ first:InsertDefault rest:(_ "," _ InsertDefault)* _ ")" {
      return [first, ...rest.map(r => r[3])];
    }

InsertDefault
  = name:Variable _ "=" _ c:Constant { return [name, c]; }

AttributesDecl
  = first:AttributeDecl rest:(_ "," _ AttributeDecl)* {
      return [first, ...rest.map(r => r[3])];
    }

AttributeDecl
  = name:AttributeName _ ":" _ ty:DataType {
      return options.b.attribute(name, ty);
    }

InDecl  = ".input"  _ path:FilePath { return path; }
OutDecl = ".output" _ path:FilePath { return path; }

FilePath
  = name:FileName "." ext:("facts" / "csv" / "txt") { return name + "." + ext; }

FileName
  = $("_"? [A-Za-z]+ [A-Za-z0-9_-]*)

RuleDecl
  = (".rule" _)? rules:Rule+ { return rules; }

// A query: a rule that brings its own head declaration.
//
//     ?- Payroll(d, sum(s)) :- Person(i, n, d), Salary(i, s).
//
// Shorthand and nothing more — it desugars to `.decl Payroll()` plus the rule,
// which is a declaration the language already had: `.decl Foo()` leaves the
// schema to the rules, and `inferRelationTypes` recovers it when something
// needs it. So a query is an ordinary IDB from the moment it is parsed, and
// every later stage — planning, execution, write-back — sees a normal program.
//
// The sugar is not preserved by `programToDl`, which re-emits the declaration
// and the rule. Nothing downstream distinguishes them, so there is nothing to
// preserve.
QueryDecl
  = first:QueryRule rest:(_ QueryRule)* {
      const items = [first, ...rest.map(r => r[1])];
      const named = items.filter(i => i.kind === "named");
      return {
        rules: named.map(i => i.rule),
        queryIdbs: named.map(i => options.b.relDecl(i.rule.head.name, [], null)),
        bareGoals: items.filter(i => i.kind === "bare"),
      };
    }

// Two forms. The named one gives the result a name; the bare one is Prolog's
// "show me the answers", and its head is built in the `Program` action, where
// the names already taken are known.
QueryRule
  = "?-" _ head:Head _ ":-" _ body:Predicates _ "." _ opt:Optimize? _ {
      let planning = false;
      let sip = false;
      if (opt === ".plan") planning = true;
      else if (opt === ".sip") sip = true;
      else if (opt === ".optimize") { planning = true; sip = true; }
      return { kind: "named", rule: options.b.rule(head, body, planning, sip) };
    }
  / "?-" _ body:Predicates _ "." _ opt:Optimize? _ {
      let planning = false;
      let sip = false;
      if (opt === ".plan") planning = true;
      else if (opt === ".sip") sip = true;
      else if (opt === ".optimize") { planning = true; sip = true; }
      // Reported here rather than in `Program` so the error points at the
      // query rather than at the whole file.
      if (options.b.bareQueryColumns(body).length === 0) {
        error(
          "a bare `?-` query reports the variables its body binds, and this one binds none — " +
          "add a variable, or use the named form `?- Name(...) :- ...`"
        );
      }
      return { kind: "bare", rhs: body, planning, sip };
    }

Rule
  = head:Head _ ":-" _ body:Predicates _ "." _ opt:Optimize? _ {
      let planning = false;
      let sip = false;
      if (opt === ".plan") planning = true;
      else if (opt === ".sip") sip = true;
      else if (opt === ".optimize") { planning = true; sip = true; }
      return options.b.rule(head, body, planning, sip);
    }

Predicates
  = first:Predicate rest:(_ "," _ Predicate)* {
      return [first, ...rest.map(r => r[3])];
    }

Predicate
  = atom:NegAtom { return options.b.predNegated(atom); }
  / cmp:CompareExpr { return options.b.predCompare(cmp); }
  / atom:Atom { return options.b.predAtom(atom); }
  / b:Boolean { return options.b.predBoolean(b); }

Optimize
  = ".plan" / ".sip" / ".optimize"

Atom
  = name:RelationName _ "(" _ args:AtomArgList? _ ")" {
      return options.b.atom(name, args || []);
    }

NegAtom
  = "!" _ atom:Atom { return atom; }

AtomArgList
  = first:AtomArg rest:(_ "," _ AtomArg)* {
      return [first, ...rest.map(r => r[3])];
    }

AtomArg
  = v:Variable    { return options.b.atomArgVar(v); }
  / c:Constant    { return options.b.atomArgConst(c); }
  / Placeholder   { return options.b.atomArgPlaceholder(); }

// HEAD — supports up to one aggregate as the last argument.
Head
  = name:RelationName _ "(" _ args:HeadArgList _ ")" {
      return options.b.head(name, args);
    }

HeadArgList
  = first:HeadInitArg rest:(_ "," _ HeadFollowArg)* {
      return [first, ...rest.map(r => r[3])];
    }

HeadInitArg
  = a:Aggregate { return options.b.headArgAgg(a); }
  / a:Arithmics { return options.b.headArgFromArithmic(a); }

HeadFollowArg
  = a:Aggregate { return options.b.headArgAgg(a); }
  / a:Arithmics { return options.b.headArgFromArithmic(a); }

Aggregate
  = op:AggregateOp _ "(" _ a:Arithmics _ ")" {
      return options.b.aggregation(op, a);
    }

AggregateOp
  = "count" { return "Count"; }
  / "sum"   { return "Sum"; }
  / "min"   { return "Min"; }
  / "max"   { return "Max"; }

CompareExpr
  = left:Arithmics _ op:CompareOp _ right:Arithmics {
      return options.b.compareExpr(left, op, right);
    }

CompareOp
  = "=="           { return "Equals"; }
  / "="            { return "Equals"; }
  / "!="           { return "NotEquals"; }
  / ">="           { return "GreaterEqualThan"; }
  / ">"            { return "GreaterThan"; }
  / "<="           { return "LessEqualThan"; }
  / "<"            { return "LessThan"; }

Arithmics
  = init:Factor rest:(_ ArithmicOp _ Factor)* {
      return options.b.arithmetic(init, rest.map(r => [r[1], r[3]]));
    }

Factor
  = v:Variable  { return options.b.factorVar(v); }
  / c:Constant  { return options.b.factorConst(c); }

ArithmicOp
  = "+" { return "Plus"; }
  / "-" { return "Minus"; }
  / "*" { return "Multiply"; }
  / "/" { return "Divide"; }
  / "%" { return "Modulo"; }

// Float must precede Integer so `3.14` doesn't greedily parse as `3` plus
// stray `.14` chars. Both forms reject leading whitespace inside the literal.
Constant
  = f:Float   { return options.b.constFloat(f); }
  / i:Integer { return options.b.constInteger(i); }
  / s:String  { return options.b.constText(s); }

Float
  = $(("+" / "-")? [0-9]+ "." [0-9]+) { return Number(text()); }

Integer
  = $(("+" / "-")? [0-9]+) { return Number(text()); }

String
  = "\"" chars:$([^"]*) "\"" { return chars; }

Placeholder = "_"

Boolean = "True" { return true; } / "False" { return false; }

Variable      = id:Identifier { return id; }
AttributeName = id:Identifier { return id; }
RelationName  = id:Identifier { return id; }

Identifier
  = $("_"? [A-Za-z]+ [A-Za-z0-9_]*)

DataType
  = "number" { return "Integer"; }
  / "string" { return "String"; }
  / "float"  { return "Float"; }
  / "any"    { return "Any"; }

// Whitespace + comments. Skipped between every grammar token.
_ "whitespace"
  = (Ws / Comment)*

Ws = [ \t\n\r]+

Comment
  = "#" (![\n\r] .)*
  / "//" (![\n\r] .)*
