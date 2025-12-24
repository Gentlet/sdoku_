sudo docker compose up -d --build

docker compose up -d --build judge-api
sudo docker exec -i judge-db mysql -uroot -prootpw judge < /volume1/docker/web/judge-api/schema.sql
sudo docker exec -i judge-db mysql -uroot -prootpw judge < /volume1/docker/web/judge-api/testcase.sql

sudo docker exec -it judge-db mysql -uroot -prootpw judge -e "
INSERT INTO problems(title, description, time_limit_ms, memory_limit_kb)
VALUES('스도쿠 풀이', '입력: 9줄(0은 빈칸). 출력: 완성된 9줄.', 2000, 262144);"

sudo docker exec -it judge-db mysql -uroot -prootpw judge -e "


docker exec -it judge-db bash
mysql -u root -p