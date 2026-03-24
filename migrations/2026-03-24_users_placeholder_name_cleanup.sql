UPDATE public.users
SET full_name = CASE
  WHEN email IS NULL OR position('@' IN email) = 0 THEN 'Beacon User'
  ELSE COALESCE(
    NULLIF(
      left(
        trim(
          regexp_replace(
            regexp_replace(split_part(email, '@', 1), '[._-]+', ' ', 'g'),
            '\s+',
            ' ',
            'g'
          )
        ),
        50
      ),
      ''
    ),
    'Beacon User'
  )
END,
updated_at = NOW()
WHERE full_name IS NOT NULL
  AND regexp_replace(btrim(full_name), '\s+', ' ', 'g') ~* '^User\s+[0-9]+$';
