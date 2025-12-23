sudo docker compose up -d --build


sudo docker exec -i judge-db mysql -uroot -prootpw judge < /volume1/docker/web/judge-api/schema.sql

sudo docker exec -it judge-db mysql -uroot -prootpw judge -e "
INSERT INTO problems(title, description, time_limit_ms, memory_limit_kb)
VALUES('스도쿠 풀이', '입력: 9줄(0은 빈칸). 출력: 완성된 9줄.', 2000, 262144);"

sudo docker exec -it judge-db mysql -uroot -prootpw judge -e "
INSERT INTO test_cases(problem_id, input_text, expected_output, is_sample)
VALUES
(1,
'530070000600195000098000060800060003400803001700020006060000280000419005000080079',
'534678912672195348198342567859761423426853791713924856961537284287419635345286179',
1);
"
