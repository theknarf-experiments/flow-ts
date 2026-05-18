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
      for (const s of sections) {
        if (s.edbs) for (const e of s.edbs) edbs.push(e);
        if (s.idbs) for (const i of s.idbs) idbs.push(i);
        if (s.rules) for (const r of s.rules) rules.push(r);
      }
      return options.b.program(edbs, idbs, rules);
    }

// Each section is one of: (edb + idb), edb alone, or idb alone — optionally
// followed by a rule block. Matches the pest main_grammar pattern.
Section
  = edbs:EdbDecl _ idbs:IdbDecl _ rules:RuleDecl? _ { return { edbs, idbs, rules: rules || [] }; }
  / edbs:EdbDecl _ rules:RuleDecl? _ { return { edbs, rules: rules || [] }; }
  / idbs:IdbDecl _ rules:RuleDecl? _ { return { idbs, rules: rules || [] }; }

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
  = ".decl" _ name:RelationName _ "(" _ attrs:AttributesDecl? _ ")" path:(_ OutDecl)? {
      return options.b.relDecl(name, attrs || [], path ? path[1] : null);
    }

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

Constant
  = i:Integer { return options.b.constInteger(i); }
  / s:String  { return options.b.constText(s); }

Integer
  = $(("+" / "-")? [0-9]+) { return BigInt(text()); }

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

// Whitespace + comments. Skipped between every grammar token.
_ "whitespace"
  = (Ws / Comment)*

Ws = [ \t\n\r]+

Comment
  = "#" (![\n\r] .)*
  / "//" (![\n\r] .)*
