UPDATE "PublicTypebot"
SET "settings" = jsonb_set("settings", '{general,isInputPrefillEnabled}', 'false')
WHERE "id" = 'cmmy41w3m0002my1z919waitb';

UPDATE "Typebot"
SET "settings" = (SELECT "settings" FROM "PublicTypebot" WHERE "id" = 'cmmy41w3m0002my1z919waitb')
WHERE "publicId" = 'solar-lead-gen';
