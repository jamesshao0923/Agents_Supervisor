import test from 'node:test';
import {exerciseMaintenance} from '../helpers/control-maintenance-controller-fixture.js';
test('P6-MAINT-I07 actual stopped rejected maintenance review preserves original head failure history cost and protected final reserve',{timeout:290000},t=>exerciseMaintenance(t,'reject'));
