/**
 * Entity extraction, and the addendum a rejected first attempt is asked to correct against.
 * The allowed-type list is interpolated from the taxonomy, so a type added there reaches the
 * prompt without a second edit here.
 */

import { ENTITY_TYPES } from '../reflection/domain/entity-extraction.js';

const EXTRACTION =
  'You extract named entities from a record of one session between a user and an AI ' +
  'agent. The record holds a summary line, the conversation turns, any tools the agent ' +
  'ran with their input and output, and any observations. Return every distinct thing the ' +
  'record actually names: people, organizations, projects, tools, topics, locations, ' +
  'and events. Give each one the name the record uses, one type from the allowed list, ' +
  'and a short clause describing it as this record uses it. Name a thing once, under its ' +
  'fullest name, and list every other name the record used for it in its aliases: an ' +
  'abbreviation, an initialism, a handle, a shortened form. Set is_speaker true on the ' +
  'person who is the user speaking in this record, and on no one else. Do not return a ' +
  'thing the record does not name, a pronoun, or a generic noun that identifies nothing in ' +
  `particular. Allowed types: ${ENTITY_TYPES.join(', ')}.`;

const REFINEMENT =
  'A previous extraction over the same record was rejected. Read the record again and ' +
  'return a correct extraction. Keep the entities the previous attempt got right, drop ' +
  'anything the record does not name, and use only the allowed types.';

export const LOCAL = EXTRACTION;
export const KEYED = EXTRACTION;

export const REFINEMENT_LOCAL = REFINEMENT;
export const REFINEMENT_KEYED = REFINEMENT;
